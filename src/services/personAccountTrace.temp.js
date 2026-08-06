/**
 * TEMPORARY DEBUG ONLY — Phase 15.3.1 Person Account Resolution Trace.
 *
 * Traces exactly one metadata node through the deployment pipeline:
 *   RecordType : PersonAccount.PersonAccount
 *
 * Logging only. Never changes discovery, merge, classification, resolution,
 * destination validation, package generation, workspace, or CLI behavior.
 * Remove once the PersonAccount investigation is complete.
 */

const TRACED_TYPE = 'RecordType';
const TRACED_NAME = 'PersonAccount.PersonAccount';
const TRACED_KEY = `${TRACED_TYPE}:${TRACED_NAME}`;

const STEPS = Object.freeze([
    'discovery',
    'merge',
    'resolver',
    'destination',
    'package',
    'workspace',
    'deployment'
]);

const state = createEmptyState();

function createEmptyState() {
    return {
        discovery: null,
        merge: null,
        resolver: null,
        destination: null,
        package: null,
        workspace: null,
        deployment: null
    };
}

function banner(title) {
    console.log('====================================================');
    console.log(title);
    console.log('====================================================');
}

function value(input) {
    return input === null || input === undefined || input === ''
        ? '(unknown)'
        : String(input);
}

function yesNo(input) {
    return input === true ? 'YES' : 'NO';
}

function getType(item) {
    return item?.metadataType || item?.type || null;
}

function getName(item) {
    return item?.name || item?.metadataName || null;
}

/**
 * True only for the single traced node. Every other RecordType is ignored so
 * the trace never floods deployments that contain many record types.
 */
function isTracedNode(item) {
    return getType(item) === TRACED_TYPE && getName(item) === TRACED_NAME;
}

function findTracedNode(items) {
    if (!Array.isArray(items)) {
        return null;
    }

    return items.find((item) => isTracedNode(item)) || null;
}

function beginPersonAccountTrace() {
    Object.assign(state, createEmptyState());
}

/** STEP 1 — PermissionSet relationship discoverer. */
function logDiscoveryStep({ permissionSetName = null, relationships = [] } = {}) {
    const emitted = findTracedNode(relationships);

    if (!emitted && state.discovery?.emitted) {
        return;
    }

    state.discovery = {
        permissionSetName: permissionSetName || null,
        emitted: Boolean(emitted),
        dto: emitted || null
    };

    banner('PERSON ACCOUNT TRACE — STEP 1 DISCOVERY');
    console.log('');
    console.log('PermissionSet:');
    console.log(value(permissionSetName));
    console.log('');
    console.log('RecordType Found:');
    console.log(TRACED_NAME);
    console.log('');
    console.log('Relationship Emitted:');
    console.log(yesNo(Boolean(emitted)));
    console.log('');
    console.log('DTO:');
    console.log(emitted ? JSON.stringify(emitted, null, 2) : '(none)');
    console.log('');
    console.log('====================================================');
}

/** STEP 2 — merge of discovered relationships into the dependency graph. */
function logMergeStep({ dependencies = [], relationships = [] } = {}) {
    const merged = findTracedNode(dependencies);

    state.merge = {
        present: Boolean(merged),
        relationshipCount: Array.isArray(relationships)
            ? relationships.length
            : 0,
        dependencyCount: Array.isArray(dependencies) ? dependencies.length : 0,
        dto: merged || null
    };

    banner('PERSON ACCOUNT TRACE — STEP 2 MERGE');
    console.log('');
    console.log('Dependency Present:');
    console.log(yesNo(Boolean(merged)));
    console.log('');
    console.log('Relationship Count:');
    console.log(state.merge.relationshipCount);
    console.log('');
    console.log('Dependency Graph Size:');
    console.log(state.merge.dependencyCount);
    console.log('');
    console.log('DTO:');
    console.log(merged ? JSON.stringify(merged, null, 2) : '(none)');
    console.log('');
    console.log('====================================================');
}

/** STEP 3a — dependency entering resolution, before resolver selection. */
function logResolutionIncoming(dependency) {
    if (!isTracedNode(dependency)) {
        return;
    }

    state.resolver = {
        ...(state.resolver || {}),
        incoming: true,
        classification: dependency.classification || null,
        incomingArtifactRequired: dependency.artifactRequired,
        incomingPackageable: dependency.packageable
    };

    banner('PERSON ACCOUNT TRACE — STEP 3 RESOLUTION');
    console.log('');
    console.log('Incoming Dependency');
    console.log('');
    console.log('metadataType:');
    console.log(TRACED_TYPE);
    console.log('');
    console.log('name:');
    console.log(TRACED_NAME);
    console.log('');
    console.log('classification:');
    console.log(value(dependency.classification));
    console.log('');
    console.log('====================================================');
}

/** STEP 3b — resolver selection outcome. */
function logResolverSelection(dependency, resolver) {
    if (!isTracedNode(dependency)) {
        return;
    }

    state.resolver = {
        ...(state.resolver || {}),
        resolverId: resolver?.id || null,
        invoked: Boolean(resolver)
    };

    console.log('Resolver Selected:');
    console.log(resolver?.id || '(none — classification default)');
    console.log('');
    console.log('Invoked:');
    console.log(yesNo(Boolean(resolver)));
    console.log('');
    console.log('====================================================');
}

/** STEP 3c — decision returned by the resolver / classification default. */
function logResolverDecision(dependency, decision) {
    if (!isTracedNode(dependency)) {
        return;
    }

    state.resolver = {
        ...(state.resolver || {}),
        action: decision?.action || null,
        destinationState: decision?.destinationState || null,
        artifactRequired: decision?.artifactRequired,
        selected: decision?.selected,
        packageable: decision?.packageable,
        blocking: decision?.action === 'BLOCK',
        reason: decision?.reason || null
    };

    console.log('Decision:');
    console.log(value(decision?.action));
    console.log('');
    console.log('destinationState:');
    console.log(value(decision?.destinationState));
    console.log('');
    console.log('artifactRequired:');
    console.log(String(decision?.artifactRequired));
    console.log('');
    console.log('selected:');
    console.log(String(decision?.selected));
    console.log('');
    console.log('packageable:');
    console.log(String(decision?.packageable));
    console.log('');
    console.log('blocking:');
    console.log(String(decision?.action === 'BLOCK'));
    console.log('');
    console.log('Reason:');
    console.log(value(decision?.reason));
    console.log('');
    console.log('====================================================');
}

/** STEP 4 — destination existence query. */
function logDestinationStep({
    metadataType = null,
    metadataName = null,
    soql = null,
    records = [],
    totalSize = null,
    decision = null,
    warning = null
} = {}) {
    if (!isTracedNode({ metadataType, metadataName })) {
        return;
    }

    const returnedRecords = Array.isArray(records) ? records : [];

    state.destination = {
        soql: soql || null,
        returnedRecords: totalSize != null ? totalSize : returnedRecords.length,
        decision: decision || null,
        warning: warning || null,
        records: returnedRecords.map((record) => ({
            DeveloperName: record?.DeveloperName ?? null,
            SobjectType: record?.SobjectType ?? null,
            IsPersonType: record?.IsPersonType ?? null
        }))
    };

    banner('PERSON ACCOUNT TRACE — STEP 4 DESTINATION');
    console.log('');
    console.log('SOQL');
    console.log('');
    console.log(value(soql));
    console.log('');
    console.log('Returned Records:');
    console.log(state.destination.returnedRecords);
    console.log('');

    for (const record of state.destination.records) {
        console.log('DeveloperName:', value(record.DeveloperName));
        console.log('SobjectType:', value(record.SobjectType));
        console.log('IsPersonType:', String(record.IsPersonType));
        console.log('----------------------------------------------------');
    }

    console.log('Decision:');
    console.log(value(decision));
    console.log('');

    if (warning) {
        console.log('Warning:');
        console.log(warning);
        console.log('');
    }

    console.log('====================================================');
}

/** STEP 5 — package generation membership. */
function logPackageStep({
    generatedDeploymentPackage = null,
    resolvedDependencies = []
} = {}) {
    const packageMembers = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];
    const inPackage = Boolean(findTracedNode(packageMembers));
    const decision = findTracedNode(resolvedDependencies);
    const reason = inPackage
        ? 'Dependency carried a DEPLOY decision and was auto-included.'
        : decision
          ? `Excluded because the resolved action is ${value(decision.action)}.`
          : 'Excluded because the dependency is absent from the resolved dependency list.';

    state.package = {
        added: inPackage,
        action: decision?.action || null,
        reason
    };

    banner('PERSON ACCOUNT TRACE — STEP 5 PACKAGE');
    console.log('');
    console.log('Added to package.xml:');
    console.log(yesNo(inPackage));
    console.log('');
    console.log('Resolved Action:');
    console.log(value(decision?.action));
    console.log('');
    console.log('Reason:');
    console.log(reason);
    console.log('');
    console.log('====================================================');
}

/** STEP 6 — workspace construction. */
function logWorkspaceStep({
    resolvedDependencies = [],
    generatedDeploymentPackage = null,
    workspaceSkipped = false,
    skipReason = null
} = {}) {
    const decision = findTracedNode(resolvedDependencies);
    const packageMembers = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];
    const inPackage = Boolean(findTracedNode(packageMembers));
    const artifactRequired = decision?.artifactRequired === true;

    state.workspace = {
        artifactRequired,
        resolutionAttempted: inPackage,
        artifactPath: decision?.filePath || null,
        found: decision?.artifactResolved === true,
        workspaceSkipped: workspaceSkipped === true,
        skipReason: skipReason || null
    };

    banner('PERSON ACCOUNT TRACE — STEP 6 WORKSPACE');
    console.log('');
    console.log('Artifact Required:');
    console.log(yesNo(artifactRequired));
    console.log('');
    console.log('Artifact Resolution Attempted:');
    console.log(yesNo(inPackage));
    console.log('');
    console.log('Artifact Path:');
    console.log(value(decision?.filePath));
    console.log('');
    console.log('Found:');
    console.log(yesNo(decision?.artifactResolved === true));
    console.log('');
    console.log('Workspace Skipped:');
    console.log(yesNo(workspaceSkipped === true));
    console.log('');
    console.log('Skip Reason:');
    console.log(value(skipReason));
    console.log('');
    console.log('====================================================');
}

/** STEP 7 — immediately before the CLI deployment. */
function logDeploymentStep({
    resolvedDependencies = [],
    generatedDeploymentPackage = null,
    dependencyResolutionSummary = null,
    dependencyValidationStatus = null,
    deploymentSkipped = false,
    deploymentMode = null
} = {}) {
    const decision = findTracedNode(resolvedDependencies);
    const packageMembers = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];
    const recordTypeIncluded = Boolean(findTracedNode(packageMembers));
    const permissionSetIncluded = packageMembers.some(
        (item) => getType(item) === 'PermissionSet'
    );
    const satisfied =
        decision?.action === 'REFERENCE' || decision?.action === 'DEPLOY';
    const reason = deploymentSkipped
        ? 'Deployment skipped by the compatibility readiness gate.'
        : decision
          ? `Resolved action ${value(
                decision.action
            )}; deployment gate reads compatibility readiness only.`
          : 'Dependency never reached resolution; nothing gated the deployment.';

    state.deployment = {
        dependencyStatus: satisfied ? 'Satisfied' : 'Unsatisfied',
        permissionSetIncluded,
        recordTypeIncluded,
        deploymentSkipped: deploymentSkipped === true,
        deploymentMode: deploymentMode || null,
        blockCount: dependencyResolutionSummary?.block ?? null,
        dependencyValidationStatus: dependencyValidationStatus || null,
        reason
    };

    banner('PERSON ACCOUNT TRACE — STEP 7 FINAL');
    console.log('');
    console.log('Dependency Status:');
    console.log(state.deployment.dependencyStatus);
    console.log('');
    console.log('PermissionSet Included:');
    console.log(yesNo(permissionSetIncluded));
    console.log('');
    console.log('RecordType Included:');
    console.log(yesNo(recordTypeIncluded));
    console.log('');
    console.log('Dependency Resolution Blocks:');
    console.log(value(dependencyResolutionSummary?.block));
    console.log('');
    console.log('Dependency Validation Status:');
    console.log(value(dependencyValidationStatus));
    console.log('');
    console.log('Deployment Skipped:');
    console.log(yesNo(deploymentSkipped === true));
    console.log('');
    console.log('Reason:');
    console.log(reason);
    console.log('');
    console.log('====================================================');
}

function evaluateStep(step) {
    switch (step) {
        case 'discovery':
            return state.discovery
                ? {
                      status: state.discovery.emitted ? 'PASS' : 'FAIL',
                      reason: state.discovery.emitted
                          ? 'PermissionSet discoverer emitted the RecordType relationship.'
                          : 'PermissionSet discoverer did not emit the RecordType relationship.'
                  }
                : { status: 'NOT RUN', reason: 'Discovery stage never executed.' };

        case 'merge':
            return state.merge
                ? {
                      status: state.merge.present ? 'PASS' : 'FAIL',
                      reason: state.merge.present
                          ? 'RecordType is present in the merged dependency graph.'
                          : 'RecordType was dropped during dependency graph merge.'
                  }
                : { status: 'NOT RUN', reason: 'Merge stage never executed.' };

        case 'resolver':
            if (!state.resolver?.incoming) {
                return {
                    status: 'NOT RUN',
                    reason: 'RecordType never entered dependency resolution.'
                };
            }

            return {
                status:
                    state.resolver.resolverId === 'personAccountRecordType'
                        ? 'PASS'
                        : 'FAIL',
                reason:
                    state.resolver.resolverId === 'personAccountRecordType'
                        ? `Person Account resolver returned ${value(
                              state.resolver.action
                          )}.`
                        : `Resolver ${value(
                              state.resolver.resolverId
                          )} handled the dependency instead of the Person Account resolver.`
            };

        case 'destination':
            if (!state.destination) {
                return {
                    status: 'NOT RUN',
                    reason: 'Destination existence was never queried for this RecordType.'
                };
            }

            return {
                status:
                    state.destination.decision === 'UNKNOWN' ? 'FAIL' : 'PASS',
                reason:
                    state.destination.decision === 'UNKNOWN'
                        ? 'Destination existence could not be determined.'
                        : `Destination existence resolved to ${value(
                              state.destination.decision
                          )}.`
            };

        case 'package':
            if (!state.package) {
                return {
                    status: 'NOT RUN',
                    reason: 'Package generation stage never executed.'
                };
            }

            // Correct behavior: a platform-managed RecordType must NOT be a
            // package member. Only a DEPLOY decision would be wrong here.
            return {
                status: state.package.added ? 'FAIL' : 'PASS',
                reason: state.package.added
                    ? 'Platform-managed RecordType was added to package.xml.'
                    : 'RecordType correctly excluded from package.xml.'
            };

        case 'workspace':
            if (!state.workspace) {
                return {
                    status: 'NOT RUN',
                    reason: 'Workspace stage never executed.'
                };
            }

            return {
                status: state.workspace.artifactRequired ? 'FAIL' : 'PASS',
                reason: state.workspace.artifactRequired
                    ? 'Workspace still required a source artifact for the RecordType.'
                    : 'No source artifact was required for the RecordType.'
            };

        case 'deployment':
            if (!state.deployment) {
                return {
                    status: 'NOT RUN',
                    reason: 'Deployment stage never executed.'
                };
            }

            if (state.deployment.dependencyStatus === 'Satisfied') {
                return {
                    status: 'PASS',
                    reason: 'RecordType exists in the destination; PermissionSet can reference it.'
                };
            }

            return {
                status: state.deployment.deploymentSkipped ? 'PASS' : 'FAIL',
                reason: state.deployment.deploymentSkipped
                    ? 'Deployment was skipped before the PermissionSet reached Salesforce.'
                    : 'PermissionSet was deployed even though the RecordType dependency was unsatisfied.'
            };

        default:
            return { status: 'NOT RUN', reason: 'Unknown stage.' };
    }
}

const STEP_LABELS = Object.freeze({
    discovery: 'STEP 1 Discovery',
    merge: 'STEP 2 Merge',
    resolver: 'STEP 3 Resolver',
    destination: 'STEP 4 Destination Validation',
    package: 'STEP 5 Package',
    workspace: 'STEP 6 Workspace',
    deployment: 'STEP 7 Deployment'
});

function resolveFirstFailingStage() {
    for (const step of STEPS) {
        const evaluation = evaluateStep(step);

        if (evaluation.status === 'FAIL' || evaluation.status === 'NOT RUN') {
            return {
                stage: STEP_LABELS[step],
                reason: evaluation.reason
            };
        }
    }

    return {
        stage: 'None',
        reason: 'PersonAccount.PersonAccount behaved as expected end to end.'
    };
}

function logPersonAccountReport() {
    console.log('====================================================');
    console.log('PERSON ACCOUNT PIPELINE REPORT');
    console.log('====================================================');
    console.log('');

    for (const step of STEPS) {
        const evaluation = evaluateStep(step);
        console.log(STEP_LABELS[step]);
        console.log(evaluation.status);
        console.log('');
    }

    const firstFailure = resolveFirstFailingStage();

    console.log('----------------------------------------------------');
    console.log('');
    console.log('FIRST FAILING STAGE');
    console.log('');
    console.log(firstFailure.stage);
    console.log('');
    console.log('Reason:');
    console.log('');
    console.log(firstFailure.reason);
    console.log('');
    console.log('====================================================');
}

function getPersonAccountTraceState() {
    return JSON.parse(JSON.stringify(state));
}

module.exports = {
    TRACED_TYPE,
    TRACED_NAME,
    TRACED_KEY,
    isTracedNode,
    beginPersonAccountTrace,
    logDiscoveryStep,
    logMergeStep,
    logResolutionIncoming,
    logResolverSelection,
    logResolverDecision,
    logDestinationStep,
    logPackageStep,
    logWorkspaceStep,
    logDeploymentStep,
    evaluateStep,
    resolveFirstFailingStage,
    logPersonAccountReport,
    getPersonAccountTraceState
};
