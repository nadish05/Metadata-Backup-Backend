'use strict';

const { ROLLBACK_CODE } = require('./snapshotRestore.errors');

function isPartialFlowDeactivationDiagnostic(entry) {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    return (
        entry.deactivated === true ||
        entry.deactivationDeploySucceeded === true ||
        entry.partialDeactivation === true
    );
}

function sanitizeDeploymentExecutionSummary(deploymentExecution) {
    if (!deploymentExecution || typeof deploymentExecution !== 'object') {
        return null;
    }

    return {
        success: deploymentExecution.success === true,
        status: deploymentExecution.status || null,
        deploymentId: deploymentExecution.deploymentId || null,
        message: deploymentExecution.message || null
    };
}

function normalizeFlowDeleteRollbackDeactivationDiagnostic(
    entry,
    failureStage = null
) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const deactivationVerified =
        entry.deactivationVerified === true ||
        (entry.deactivated === true && entry.deactivationVerified !== false);

    return {
        metadataName: entry.metadataName || null,
        flowDefinitionDeveloperName: entry.flowDefinitionDeveloperName || null,
        targetFlowVersionId: entry.targetFlowVersionId || null,
        targetFlowVersionNumber: entry.targetFlowVersionNumber ?? null,
        priorActiveVersionId: entry.priorActiveVersionId || null,
        priorActiveVersionNumber: entry.priorActiveVersionNumber ?? null,
        deactivationVerified,
        deactivationDeploySucceeded:
            entry.deactivationDeploySucceeded === true ||
            entry.deploymentExecution?.success === true,
        deploymentExecution: sanitizeDeploymentExecutionSummary(
            entry.deploymentExecution
        ),
        verificationReason: entry.verificationReason || null,
        failureStage: entry.failureStage || failureStage || null
    };
}

function diagnosticFromBlockedErrorDetails(details, failureStage) {
    if (!details?.partialDeactivation) {
        return null;
    }

    return normalizeFlowDeleteRollbackDeactivationDiagnostic(
        {
            metadataName: details.metadataName,
            flowDefinitionDeveloperName: details.flowDefinitionDeveloperName,
            targetFlowVersionId: details.targetFlowVersionId,
            targetFlowVersionNumber: details.targetFlowVersionNumber,
            priorActiveVersionId: details.priorActiveVersionId,
            priorActiveVersionNumber: details.priorActiveVersionNumber,
            deactivationVerified: details.deactivationVerified === true,
            deactivationDeploySucceeded: details.deactivationDeploySucceeded === true,
            deploymentExecution: details.deploymentExecution,
            verificationReason: details.verificationReason,
            partialDeactivation: true,
            failureStage: details.failureStage || failureStage
        },
        failureStage
    );
}

function buildFlowDeleteRollbackPartialDeactivationOutcome(
    records,
    failureStage,
    blockedErrorDetails = null
) {
    const diagnostics = [];
    const seen = new Set();

    for (const entry of records || []) {
        if (!isPartialFlowDeactivationDiagnostic(entry)) {
            continue;
        }

        const normalized = normalizeFlowDeleteRollbackDeactivationDiagnostic(
            entry,
            failureStage
        );

        if (!normalized) {
            continue;
        }

        const key = [
            normalized.metadataName,
            normalized.flowDefinitionDeveloperName,
            normalized.failureStage
        ].join('|');

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        diagnostics.push(normalized);
    }

    const fromError = diagnosticFromBlockedErrorDetails(
        blockedErrorDetails,
        failureStage
    );

    if (fromError) {
        const key = [
            fromError.metadataName,
            fromError.flowDefinitionDeveloperName,
            fromError.failureStage
        ].join('|');

        if (!seen.has(key)) {
            diagnostics.push(fromError);
        }
    }

    if (!diagnostics.length) {
        return {};
    }

    const resolvedStage =
        failureStage || diagnostics[diagnostics.length - 1].failureStage || null;

    return {
        flowDeleteRollbackDeactivation: diagnostics,
        flowDeleteRollbackPartialDeactivation: true,
        flowDeleteRollbackFailureStage: resolvedStage
    };
}

function resolveFlowDeactivationFailureStageForRollbackCode(code) {
    if (code === ROLLBACK_CODE.FLOW_DEACTIVATION_NOT_VERIFIED) {
        return 'DEACTIVATION_VERIFICATION';
    }

    if (
        code === ROLLBACK_CODE.FLOW_DEACTIVATION_CHECK_ONLY_FAILED ||
        code === ROLLBACK_CODE.FLOW_DEACTIVATION_EXECUTION_FAILED ||
        code === ROLLBACK_CODE.FLOW_DEACTIVATION_TOOLING_FAILED ||
        code === ROLLBACK_CODE.FLOW_DEACTIVATION_IDENTITY_FAILED ||
        code === ROLLBACK_CODE.FLOW_DEACTIVATION_ACTIVE_VERSION_CHANGED
    ) {
        return 'DEACTIVATION_VERIFICATION';
    }

    return null;
}

module.exports = {
    isPartialFlowDeactivationDiagnostic,
    normalizeFlowDeleteRollbackDeactivationDiagnostic,
    buildFlowDeleteRollbackPartialDeactivationOutcome,
    resolveFlowDeactivationFailureStageForRollbackCode
};
