'use strict';

const deploymentValidationStatusStore = require('./deploymentValidationStatus.store');
const deploymentCheckOnlyGateService = require('./deploymentCheckOnlyGate.service');
const deploymentExecutionService = require('./deploymentExecution.service');
const deploymentHistoryService = require('./deploymentHistory.service');
const deploymentValidationService = require('./deploymentValidation.service');
const {
    verifyWorkspaceArtifactIntegrity,
    verifyDestinationOrgIdentity
} = require('./deploymentBoundArtifact.service');

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function runHistorySafely(operation) {
    try {
        return operation();
    } catch (error) {
        console.error('DEPLOYMENT HISTORY ERROR');
        console.error(error);
        return null;
    }
}

function buildBlockedResponse(code, message, details = {}) {
    return {
        success: false,
        boundDeploy: {
            status: 'BLOCKED',
            code,
            message
        },
        ...details
    };
}

/**
 * Resolve and verify a prior validation job for bound deploy reuse.
 * @returns {{ ok: true, job: object, result: object, artifact: object } | { ok: false, response: object }}
 */
function resolveBoundValidationJob(boundValidationId) {
    if (!boundValidationId || typeof boundValidationId !== 'string') {
        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_VALIDATION_ID_REQUIRED',
                'boundValidationId is required for validation-bound deployment.'
            )
        };
    }

    const job = deploymentValidationStatusStore.getJob(boundValidationId.trim());

    if (!job) {
        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_VALIDATION_NOT_FOUND',
                'Validation reference is unknown or has expired. Re-run check-only validation.'
            )
        };
    }

    if (job.status === deploymentValidationStatusStore.STATUS.RUNNING) {
        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_VALIDATION_IN_PROGRESS',
                'Referenced validation is still running.'
            )
        };
    }

    if (job.status === deploymentValidationStatusStore.STATUS.FAILED) {
        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_VALIDATION_FAILED',
                'Referenced validation did not complete successfully.'
            )
        };
    }

    const result = job.result;

    if (!result || typeof result !== 'object') {
        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_VALIDATION_RESULT_MISSING',
                'Validation result is unavailable. Re-run check-only validation.'
            )
        };
    }

    const artifact = result.boundDeployArtifact;

    if (!artifact || typeof artifact !== 'object') {
        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_DEPLOY_NOT_ELIGIBLE',
                'This validation is not eligible for validation-bound deployment.'
            )
        };
    }

    if (artifact.validationId !== job.validationId) {
        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_ARTIFACT_MISMATCH',
                'Validation artifact reference is inconsistent.'
            )
        };
    }

    return {
        ok: true,
        job,
        result,
        artifact
    };
}

async function verifyBoundDeployPreconditions({
    artifact,
    result,
    orgId
}) {
    if (artifact.profileOnlyMinimalPackageApplied !== true) {
        return buildBlockedResponse(
            'BOUND_PROFILE_ONLY_REQUIRED',
            'Validation-bound deployment requires a Profile-only minimal package validation.'
        );
    }

    if (
        !deploymentCheckOnlyGateService.isCheckOnlySuccess(
            result.checkOnlyDeployment
        )
    ) {
        return buildBlockedResponse(
            'BOUND_CHECK_ONLY_REQUIRED',
            'Validation-bound deployment requires a successful Salesforce check-only validation.'
        );
    }

    if (result.deploymentReadiness?.canDeploy !== true) {
        return buildBlockedResponse(
            'BOUND_READINESS_BLOCKED',
            'Validated deployment is not ready for deployment.'
        );
    }

    if (result.deploymentExecution?.success === true) {
        return buildBlockedResponse(
            'BOUND_ALREADY_DEPLOYED',
            'Referenced validation already executed a deployment.'
        );
    }

    const destinationCheck = verifyDestinationOrgIdentity(artifact, orgId);

    if (!destinationCheck.ok) {
        return buildBlockedResponse(
            'BOUND_DESTINATION_ORG_MISMATCH',
            destinationCheck.reason
        );
    }

    const integrity = await verifyWorkspaceArtifactIntegrity(
        artifact,
        result.generatedManifest
    );

    if (!integrity.ok) {
        return buildBlockedResponse(
            'BOUND_ARTIFACT_INTEGRITY_FAILED',
            integrity.reason
        );
    }

    return null;
}

let runDeploymentExecution =
    deploymentExecutionService.runDeploymentExecution.bind(
        deploymentExecutionService
    );
let validateDestinationConnectivity =
    deploymentValidationService.validateDestinationConnectivity.bind(
        deploymentValidationService
    );

/**
 * Deploy using the exact workspace/manifest from a prior successful
 * Profile-only check-only validation. Does not regenerate the package.
 */
async function deployBoundValidationArtifact({
    boundValidationId,
    refreshToken,
    instanceUrl,
    orgId
}) {
    logSection('Validation-Bound Deployment Started');

    const resolved = resolveBoundValidationJob(boundValidationId);

    if (!resolved.ok) {
        return resolved.response;
    }

    const { result, artifact } = resolved;

    const preconditionError = await verifyBoundDeployPreconditions({
        artifact,
        result,
        orgId
    });

    if (preconditionError) {
        return preconditionError;
    }

    const connectivityResult = await validateDestinationConnectivity({
        refreshToken,
        instanceUrl,
        orgId
    });

    if (
        connectivityResult?.deploymentValidation?.destinationConnected !== true
    ) {
        return {
            ...connectivityResult,
            boundDeploy: {
                status: 'BLOCKED',
                code: 'BOUND_DESTINATION_CONNECTIVITY_FAILED',
                message:
                    connectivityResult?.deploymentValidation?.message ||
                    'Unable to authenticate with destination org.'
            }
        };
    }

    const generatedWorkspace = {
        ...result.generatedWorkspace,
        workspacePath: artifact.workspacePath
    };
    const generatedManifest = result.generatedManifest;
    const deploymentReadiness = result.deploymentReadiness;
    const checkOnlyDeployment = result.checkOnlyDeployment;
    const deploymentApiVersion =
        generatedManifest?.summary?.apiVersion ||
        generatedManifest?.deploymentApiVersionPolicy?.deploymentApiVersion ||
        null;

    const historyId = runHistorySafely(() =>
        deploymentHistoryService.createHistory({
            deploymentPackage: result.generatedDeploymentPackage,
            deploymentReadiness,
            metadataValidation: result.metadataValidation,
            dependencyValidation: result.dependencyValidation,
            deploymentSelections: result.deploymentSelections || []
        })
    );

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.WORKSPACE_BUILT,
            metadataSummary: result.generatedDeploymentPackage?.summary
        })
    );

    const deploymentExecution = await runDeploymentExecution({
        generatedWorkspace,
        generatedManifest,
        deploymentReadiness,
        priorCheckOnlyDeployment: checkOnlyDeployment,
        refreshToken,
        instanceUrl,
        deploymentApiVersion
    });

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.DEPLOYMENT_EXECUTED,
            deploymentSummary:
                deploymentExecution?.deploymentSummary || null,
            deploymentId: deploymentExecution?.deploymentId || null,
            errors:
                deploymentExecution?.success === false &&
                deploymentExecution?.message
                    ? [deploymentExecution.message]
                    : []
        })
    );

    const deploymentHistory = runHistorySafely(() =>
        deploymentHistoryService.completeHistory(historyId, {
            deploymentMode: 'DEPLOY',
            deploymentReadiness,
            generatedWorkspace,
            deploymentResult: deploymentExecution,
            destinationOrgId: orgId ?? null,
            sourceOrgId: result.sourceOrgId ?? null,
            deploymentPlanId: result.deploymentPlanId ?? null,
            metadataComparisonId: result.metadataComparisonId ?? null,
            boundValidationId: artifact.validationId
        })
    );

    logSection(
        deploymentExecution?.success
            ? 'Validation-Bound Deployment Completed'
            : 'Validation-Bound Deployment Failed'
    );

    return {
        success: deploymentExecution?.success === true,
        boundDeploy: {
            status: deploymentExecution?.success ? 'COMPLETED' : 'FAILED',
            code: deploymentExecution?.success
                ? 'BOUND_DEPLOY_SUCCEEDED'
                : 'BOUND_DEPLOY_FAILED',
            validationId: artifact.validationId,
            artifactDigest: artifact.artifactDigest,
            packageRegenerated: false
        },
        boundValidationId: artifact.validationId,
        deploymentExecution,
        checkOnlyDeployment,
        deploymentReadiness,
        generatedWorkspace,
        generatedManifest,
        generatedDeploymentPackage: result.generatedDeploymentPackage,
        deploymentHistory
    };
}

function setRunDeploymentExecutionForTests(fn) {
    if (typeof fn !== 'function') {
        throw new Error('setRunDeploymentExecutionForTests requires a function');
    }
    runDeploymentExecution = fn;
}

function resetRunDeploymentExecutionForTests() {
    runDeploymentExecution =
        deploymentExecutionService.runDeploymentExecution.bind(
            deploymentExecutionService
        );
}

function setValidateDestinationConnectivityForTests(fn) {
    if (typeof fn !== 'function') {
        throw new Error(
            'setValidateDestinationConnectivityForTests requires a function'
        );
    }
    validateDestinationConnectivity = fn;
}

function resetValidateDestinationConnectivityForTests() {
    validateDestinationConnectivity =
        deploymentValidationService.validateDestinationConnectivity.bind(
            deploymentValidationService
        );
}

module.exports = {
    resolveBoundValidationJob,
    verifyBoundDeployPreconditions,
    deployBoundValidationArtifact,
    setRunDeploymentExecutionForTests,
    resetRunDeploymentExecutionForTests,
    setValidateDestinationConnectivityForTests,
    resetValidateDestinationConnectivityForTests
};
