'use strict';

const {
    parseVersionQualifiedFlowMember
} = require('../flowMetadata/flowMemberIdentity.service');
const {
    discoverFlowVersions,
    findFlowDefinition,
    countExactFlowVersionRows
} = require('../retrieval/flowVersionDiscovery.service');
const {
    buildFlowDefinitionDeactivationWorkspace,
    FLOW_DEFINITION_DEACTIVATED_ACTIVE_VERSION_NUMBER
} = require('./flowDefinitionDeactivationMetadata.service');
const { ROLLBACK_CODE, RollbackBlockedError } = require('./snapshotRestore.errors');
const { isCheckOnlySuccess } = require('../deploymentCheckOnlyGate.service');
const { ROLLBACK_MODE, isDeleteRollbackEligibleMember } = require('./snapshotRollbackEligibility.service');

function isActiveFlowVersionRow(exactVersion) {
    return (
        exactVersion?.flowIsActiveVersion === true ||
        exactVersion?.flowVersionStatus === 'Active'
    );
}

function resolveExactFlowDeleteRollbackVersion(discovery, definitionDeveloperName, requestedVersion) {
    const rows = countExactFlowVersionRows(
        discovery?.versions,
        definitionDeveloperName,
        requestedVersion
    );

    if (rows.length === 0) {
        return { ok: false, reason: 'DESTINATION_FLOW_VERSION_NOT_FOUND' };
    }

    if (rows.length > 1) {
        return { ok: false, reason: 'AMBIGUOUS_DESTINATION_FLOW_VERSION' };
    }

    const exactVersion = rows[0];
    const definition = findFlowDefinition(
        discovery?.definitions,
        definitionDeveloperName
    );

    if (!definition) {
        return { ok: false, reason: 'FLOW_DEFINITION_NOT_FOUND' };
    }

    if (exactVersion.flowDefinitionDeveloperName !== definitionDeveloperName) {
        return { ok: false, reason: 'FLOW_DEFINITION_IDENTITY_MISMATCH' };
    }

    return {
        ok: true,
        exactVersion,
        definition
    };
}

function verifyFlowDefinitionDeactivated({
    discovery,
    definitionDeveloperName,
    targetFlowVersionId,
    priorActiveVersionId
} = {}) {
    const definition = findFlowDefinition(
        discovery?.definitions,
        definitionDeveloperName
    );

    if (!definition) {
        return { ok: false, reason: 'FLOW_DEFINITION_NOT_FOUND' };
    }

    if (definition.activeVersionId) {
        return {
            ok: false,
            reason: 'FLOW_DEFINITION_STILL_ACTIVE',
            activeVersionId: definition.activeVersionId
        };
    }

    const exactVersion = (discovery?.versions || []).find(
        (row) => row.sourceFlowVersionId === targetFlowVersionId
    );

    if (!exactVersion) {
        return { ok: false, reason: 'TARGET_FLOW_VERSION_NOT_FOUND' };
    }

    if (isActiveFlowVersionRow(exactVersion)) {
        return { ok: false, reason: 'TARGET_FLOW_VERSION_STILL_ACTIVE' };
    }

    if (
        priorActiveVersionId &&
        definition.activeVersionId === priorActiveVersionId
    ) {
        return { ok: false, reason: 'PRIOR_ACTIVE_VERSION_STILL_ACTIVE' };
    }

    return { ok: true, definition, exactVersion };
}

function assertActiveVersionUnchanged({
    discovery,
    definitionDeveloperName,
    requestedVersion,
    expectedActiveVersionId
} = {}) {
    const resolved = resolveExactFlowDeleteRollbackVersion(
        discovery,
        definitionDeveloperName,
        requestedVersion
    );

    if (!resolved.ok) {
        return resolved;
    }

    const { exactVersion, definition } = resolved;

    if (definition.activeVersionId !== expectedActiveVersionId) {
        return {
            ok: false,
            reason: 'ACTIVE_VERSION_CHANGED',
            expectedActiveVersionId,
            currentActiveVersionId: definition.activeVersionId || null
        };
    }

    if (!isActiveFlowVersionRow(exactVersion)) {
        return { ok: false, reason: 'TARGET_FLOW_VERSION_NOT_ACTIVE' };
    }

    if (definition.activeVersionId !== exactVersion.sourceFlowVersionId) {
        return {
            ok: false,
            reason: 'ACTIVE_VERSION_IDENTITY_MISMATCH',
            definitionActiveVersionId: definition.activeVersionId || null,
            targetFlowVersionId: exactVersion.sourceFlowVersionId || null
        };
    }

    return { ok: true, exactVersion, definition };
}

function shouldConsiderFlowDeleteRollbackDeactivation(member, rollbackMode) {
    if (
        rollbackMode !== ROLLBACK_MODE.DELETE &&
        rollbackMode !== ROLLBACK_MODE.MIXED
    ) {
        return false;
    }

    if (!isDeleteRollbackEligibleMember(member)) {
        return false;
    }

    if (member.metadataType !== 'Flow') {
        return false;
    }

    const parsed = parseVersionQualifiedFlowMember(member.metadataName);

    return parsed?.isVersionQualified === true;
}

async function ensureFlowDeleteRollbackActiveDeactivation({
    member,
    rollbackMode,
    accessToken,
    instanceUrl,
    refreshToken,
    deploymentApiVersion = null,
    discoverFlowVersionsFn = discoverFlowVersions,
    buildDeactivationWorkspaceFn = buildFlowDefinitionDeactivationWorkspace,
    checkOnlyFn,
    executeFn,
    assertOrgLockHeldFn = null
} = {}) {
    if (!shouldConsiderFlowDeleteRollbackDeactivation(member, rollbackMode)) {
        return { performed: false, skipped: true, reason: 'NOT_APPLICABLE' };
    }

    const parsed = parseVersionQualifiedFlowMember(member.metadataName);

    if (!accessToken || !instanceUrl) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_TOOLING_FAILED,
            'Flow deactivation requires destination org credentials.'
        );
    }

    let discovery;

    try {
        discovery = await discoverFlowVersionsFn({
            instanceUrl,
            accessToken
        });
    } catch (error) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_TOOLING_FAILED,
            error.message || 'Flow version discovery failed before deactivation.'
        );
    }

    const initial = resolveExactFlowDeleteRollbackVersion(
        discovery,
        parsed.definitionDeveloperName,
        parsed.sourceVersionNumber
    );

    if (!initial.ok) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_IDENTITY_FAILED,
            `Flow deactivation identity check failed (${initial.reason}).`
        );
    }

    const { exactVersion, definition } = initial;

    if (!isActiveFlowVersionRow(exactVersion)) {
        return {
            performed: false,
            skipped: true,
            reason: 'TARGET_NOT_ACTIVE',
            flowDefinitionDeveloperName: parsed.definitionDeveloperName,
            targetFlowVersionId: exactVersion.sourceFlowVersionId || null,
            targetFlowVersionNumber: exactVersion.sourceFlowVersionNumber
        };
    }

    const priorActiveVersionId = definition.activeVersionId || null;
    const priorActiveVersionNumber = definition.activeVersionNumber ?? null;

    let preDeployDiscovery;

    try {
        preDeployDiscovery = await discoverFlowVersionsFn({
            instanceUrl,
            accessToken
        });
    } catch (error) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_TOOLING_FAILED,
            error.message || 'Flow version discovery failed before deactivation deploy.'
        );
    }

    const preDeploy = assertActiveVersionUnchanged({
        discovery: preDeployDiscovery,
        definitionDeveloperName: parsed.definitionDeveloperName,
        requestedVersion: parsed.sourceVersionNumber,
        expectedActiveVersionId: priorActiveVersionId
    });

    if (!preDeploy.ok) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_ACTIVE_VERSION_CHANGED,
            `Flow active version changed before deactivation (${preDeploy.reason}).`,
            preDeploy
        );
    }

    const workspace = await buildDeactivationWorkspaceFn({
        flowDefinitionDeveloperName: parsed.definitionDeveloperName,
        apiVersion: deploymentApiVersion
    });

    const generatedManifest =
        workspace.generatedManifest ||
        workspace.generatedDeploymentPackage?.generatedManifest;

    let checkOnlyDeployment;

    try {
        checkOnlyDeployment = await checkOnlyFn({
            generatedWorkspace: workspace,
            generatedManifest,
            refreshToken,
            instanceUrl,
            deploymentApiVersion
        });
    } finally {
        if (typeof workspace.cleanup === 'function') {
            await workspace.cleanup();
        }
    }

    if (!isCheckOnlySuccess(checkOnlyDeployment)) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_CHECK_ONLY_FAILED,
            checkOnlyDeployment?.message ||
                'Flow deactivation check-only validation failed.'
        );
    }

    if (typeof assertOrgLockHeldFn === 'function') {
        assertOrgLockHeldFn();
    }

    const executeWorkspace = await buildDeactivationWorkspaceFn({
        flowDefinitionDeveloperName: parsed.definitionDeveloperName,
        apiVersion: deploymentApiVersion
    });

    let deploymentExecution;

    try {
        deploymentExecution = await executeFn({
            generatedWorkspace: executeWorkspace,
            generatedManifest: executeWorkspace.generatedManifest,
            deploymentReadiness: {
                canDeploy: true,
                overallStatus: 'READY'
            },
            priorCheckOnlyDeployment: checkOnlyDeployment,
            refreshToken,
            instanceUrl,
            deploymentApiVersion
        });
    } finally {
        if (typeof executeWorkspace.cleanup === 'function') {
            await executeWorkspace.cleanup();
        }
    }

    if (!deploymentExecution?.success) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_EXECUTION_FAILED,
            deploymentExecution?.message || 'Flow deactivation deployment failed.'
        );
    }

    let postDiscovery;

    try {
        postDiscovery = await discoverFlowVersionsFn({
            instanceUrl,
            accessToken
        });
    } catch (error) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_NOT_VERIFIED,
            error.message ||
                'Flow deactivation could not be verified (Tooling failed).'
        );
    }

    const verification = verifyFlowDefinitionDeactivated({
        discovery: postDiscovery,
        definitionDeveloperName: parsed.definitionDeveloperName,
        targetFlowVersionId: exactVersion.sourceFlowVersionId,
        priorActiveVersionId
    });

    if (!verification.ok) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.FLOW_DEACTIVATION_NOT_VERIFIED,
            `Flow deactivation verification failed (${verification.reason}).`,
            {
                partialDeactivation: true,
                deactivated: true,
                metadataName: member.metadataName,
                flowDefinitionDeveloperName: parsed.definitionDeveloperName,
                targetFlowVersionId: exactVersion.sourceFlowVersionId || null,
                targetFlowVersionNumber: exactVersion.sourceFlowVersionNumber,
                priorActiveVersionId,
                priorActiveVersionNumber,
                deploymentExecution,
                verificationReason: verification.reason
            }
        );
    }

    return {
        performed: true,
        deactivated: true,
        metadataName: member.metadataName,
        flowDefinitionDeveloperName: parsed.definitionDeveloperName,
        targetFlowVersionId: exactVersion.sourceFlowVersionId || null,
        targetFlowVersionNumber: exactVersion.sourceFlowVersionNumber,
        priorActiveVersionId,
        priorActiveVersionNumber,
        flowDefinitionDeactivationActiveVersionNumber:
            FLOW_DEFINITION_DEACTIVATED_ACTIVE_VERSION_NUMBER,
        checkOnlyDeployment,
        deploymentExecution
    };
}

module.exports = {
    shouldConsiderFlowDeleteRollbackDeactivation,
    resolveExactFlowDeleteRollbackVersion,
    verifyFlowDefinitionDeactivated,
    assertActiveVersionUnchanged,
    ensureFlowDeleteRollbackActiveDeactivation
};
