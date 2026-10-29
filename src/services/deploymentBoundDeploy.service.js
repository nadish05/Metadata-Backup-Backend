'use strict';

const deploymentValidationStatusStore = require('./deploymentValidationStatus.store');
const deploymentCheckOnlyGateService = require('./deploymentCheckOnlyGate.service');
const deploymentExecutionService = require('./deploymentExecution.service');
const deploymentHistoryService = require('./deploymentHistory.service');
const destinationSnapshotCaptureService = require('./deploymentSnapshot/destinationSnapshotCapture.service');
const {
    resolveVerifiedDestinationOrgId
} = require('./deploymentOrgLock/destinationOrgIdentity.service');
const { OrgLockIdentityError } = require('./deploymentOrgLock/deploymentOrgLock.errors');
const {
    verifyBoundDeployArtifactIntegrity,
    verifyArtifactDestinationOrgIdentity
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

function metadataToSelectedMetadata(metadata) {
    if (!Array.isArray(metadata)) {
        return [];
    }

    return metadata
        .map((item) => {
            if (!item?.metadataType || !item?.metadataName) {
                return null;
            }

            return {
                metadataType: item.metadataType,
                metadataName: item.metadataName
            };
        })
        .filter(Boolean);
}

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

async function verifyBoundDeployPreconditions({ artifact, result }) {
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

    const integrity = await verifyBoundDeployArtifactIntegrity({
        artifactRecord: artifact,
        manifest: result.generatedManifest,
        generatedDeploymentPackage: result.generatedDeploymentPackage,
        strict: true
    });

    if (!integrity.ok) {
        return buildBlockedResponse(
            'BOUND_ARTIFACT_INTEGRITY_FAILED',
            integrity.reason
        );
    }

    return null;
}

function classifyDeploymentOutcome(deploymentExecution, error) {
    if (error) {
        return deploymentValidationStatusStore.BOUND_DEPLOY_CLAIM_STATE.UNCERTAIN;
    }

    if (deploymentExecution?.success === true) {
        return deploymentValidationStatusStore.BOUND_DEPLOY_CLAIM_STATE.CONSUMED;
    }

    if (
        deploymentExecution &&
        (deploymentExecution.success === false ||
            deploymentExecution.status === 'BLOCKED' ||
            deploymentExecution.status === 'FAILED')
    ) {
        return deploymentValidationStatusStore.BOUND_DEPLOY_CLAIM_STATE.DEPLOY_FAILED;
    }

    return deploymentValidationStatusStore.BOUND_DEPLOY_CLAIM_STATE.UNCERTAIN;
}

let runDeploymentExecution =
    deploymentExecutionService.runDeploymentExecution.bind(
        deploymentExecutionService
    );
let runDeployAfterOptionalSnapshot =
    destinationSnapshotCaptureService.runDeployAfterOptionalSnapshot.bind(
        destinationSnapshotCaptureService
    );
let resolveVerifiedOrgId = resolveVerifiedDestinationOrgId;

async function verifyBoundDestinationIdentity({ refreshToken, instanceUrl, artifact }) {
    try {
        const verifiedOrgId = await resolveVerifiedOrgId({
            refreshToken,
            instanceUrl,
            requestedOrgId: null
        });

        const destinationCheck = verifyArtifactDestinationOrgIdentity(
            artifact,
            verifiedOrgId
        );

        if (!destinationCheck.ok) {
            return {
                ok: false,
                response: buildBlockedResponse(
                    'BOUND_DESTINATION_ORG_MISMATCH',
                    destinationCheck.reason
                )
            };
        }

        return { ok: true, verifiedOrgId };
    } catch (error) {
        const message =
            error instanceof OrgLockIdentityError
                ? error.message
                : 'Destination org identity verification failed.';

        return {
            ok: false,
            response: buildBlockedResponse(
                'BOUND_DESTINATION_IDENTITY_FAILED',
                message
            )
        };
    }
}

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
        result
    });

    if (preconditionError) {
        return preconditionError;
    }

    if (!refreshToken || !instanceUrl) {
        return buildBlockedResponse(
            'BOUND_DESTINATION_CREDENTIALS_REQUIRED',
            'refreshToken and instanceUrl are required for bound deployment.'
        );
    }

    const historyId = runHistorySafely(() =>
        deploymentHistoryService.createHistory({
            deploymentPackage: result.generatedDeploymentPackage,
            deploymentReadiness: result.deploymentReadiness,
            metadataValidation: result.metadataValidation,
            dependencyValidation: result.dependencyValidation,
            deploymentSelections: result.deploymentSelections || []
        })
    );

    const claimResult = deploymentValidationStatusStore.tryAcquireBoundDeployClaim(
        boundValidationId,
        { historyId }
    );

    if (!claimResult.acquired) {
        return buildBlockedResponse(
            claimResult.code || 'BOUND_DEPLOY_NOT_AVAILABLE',
            claimResult.message || 'Validated artifact is not available for bound deployment.'
        );
    }

    let deploymentExecution;
    let deployCapturedSnapshot = null;
    let verifiedOrgId = null;

    try {
        const identity = await verifyBoundDestinationIdentity({
            refreshToken,
            instanceUrl,
            artifact
        });

        if (!identity.ok) {
            deploymentValidationStatusStore.releaseBoundDeployClaimInProgress(
                boundValidationId
            );
            return identity.response;
        }

        verifiedOrgId = identity.verifiedOrgId;

        const preExecuteIntegrity = await verifyBoundDeployArtifactIntegrity({
            artifactRecord: artifact,
            manifest: result.generatedManifest,
            generatedDeploymentPackage: result.generatedDeploymentPackage,
            strict: true
        });

        if (!preExecuteIntegrity.ok) {
            deploymentValidationStatusStore.releaseBoundDeployClaimInProgress(
                boundValidationId
            );
            return buildBlockedResponse(
                'BOUND_ARTIFACT_INTEGRITY_FAILED',
                preExecuteIntegrity.reason
            );
        }

        const generatedWorkspace = {
            ...result.generatedWorkspace,
            workspacePath: preExecuteIntegrity.canonicalWorkspaceRoot
        };
        const generatedManifest = {
            ...result.generatedManifest,
            packageXml: preExecuteIntegrity.packageXmlOnDisk
        };
        const deploymentReadiness = result.deploymentReadiness;
        const checkOnlyDeployment = result.checkOnlyDeployment;
        const deploymentApiVersion =
            generatedManifest?.summary?.apiVersion ||
            generatedManifest?.deploymentApiVersionPolicy?.deploymentApiVersion ||
            null;

        runHistorySafely(() =>
            deploymentHistoryService.updateHistory(historyId, {
                stage: deploymentHistoryService.STAGES.WORKSPACE_BUILT,
                metadataSummary: result.generatedDeploymentPackage?.summary
            })
        );

        const snapshotGate = await runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: {
                destinationOrgId: verifiedOrgId,
                sourceOrgId: result.sourceOrgId ?? null,
                historyId,
                sourceBranch: result.sourceBranch ?? null,
                destinationBranch: result.destinationBranch ?? null,
                generatedDeploymentPackage: result.generatedDeploymentPackage,
                selectedMetadata: metadataToSelectedMetadata(
                    result.generatedDeploymentPackage?.metadata
                ),
                generatedWorkspace,
                refreshToken,
                instanceUrl,
                deploymentApiVersion,
                sourceMetadataApiVersion: result.sourceMetadataApiVersion ?? null
            },
            runDeploymentExecution: async () => {
                const immediateIntegrity =
                    await verifyBoundDeployArtifactIntegrity({
                        artifactRecord: artifact,
                        manifest: generatedManifest,
                        generatedDeploymentPackage:
                            result.generatedDeploymentPackage,
                        strict: true
                    });

                if (!immediateIntegrity.ok) {
                    return {
                        success: false,
                        status: 'BLOCKED',
                        message: immediateIntegrity.reason,
                        mode: 'execution',
                        executionMode: 'deploy'
                    };
                }

                return runDeploymentExecution({
                    generatedWorkspace: {
                        ...generatedWorkspace,
                        workspacePath: immediateIntegrity.canonicalWorkspaceRoot
                    },
                    generatedManifest: {
                        ...generatedManifest,
                        packageXml: immediateIntegrity.packageXmlOnDisk
                    },
                    deploymentReadiness,
                    priorCheckOnlyDeployment: checkOnlyDeployment,
                    refreshToken,
                    instanceUrl,
                    deploymentApiVersion
                });
            },
            afterLockedExecution: async ({ snapshot }) => {
                if (snapshot?.snapshotId) {
                    runHistorySafely(() =>
                        deploymentHistoryService.updateHistory(historyId, {
                            snapshotId: snapshot.snapshotId
                        })
                    );
                }
            }
        });

        deploymentExecution = snapshotGate.deploymentExecution;
        deployCapturedSnapshot = snapshotGate.snapshot || null;

        const claimOutcome = classifyDeploymentOutcome(deploymentExecution);

        deploymentValidationStatusStore.finalizeBoundDeployClaim(
            boundValidationId,
            claimOutcome,
            {
                historyId,
                salesforceDeploymentId: deploymentExecution?.deploymentId || null
            }
        );
    } catch (error) {
        console.error('BOUND DEPLOY EXECUTION ERROR');
        console.error(error);

        deploymentValidationStatusStore.finalizeBoundDeployClaim(
            boundValidationId,
            deploymentValidationStatusStore.BOUND_DEPLOY_CLAIM_STATE.UNCERTAIN,
            {
                historyId,
                errorMessage: error.message || 'Bound deployment failed with uncertain outcome.'
            }
        );

        return buildBlockedResponse(
            'BOUND_DEPLOY_UNCERTAIN',
            'Bound deployment ended with an uncertain outcome. Explicit reconciliation is required before retry.',
            { historyId }
        );
    }

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.DEPLOYMENT_EXECUTED,
            deploymentSummary: deploymentExecution?.deploymentSummary || null,
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
            deploymentReadiness: result.deploymentReadiness,
            generatedWorkspace: {
                ...result.generatedWorkspace,
                workspacePath: artifact.canonicalWorkspaceRoot
            },
            deploymentResult: deploymentExecution,
            destinationOrgId: verifiedOrgId ?? null,
            sourceOrgId: result.sourceOrgId ?? null,
            deploymentPlanId: result.deploymentPlanId ?? null,
            metadataComparisonId: result.metadataComparisonId ?? null,
            snapshotId:
                deploymentHistoryService.getHistory(historyId)?.snapshotId ??
                deployCapturedSnapshot?.snapshotId ??
                null
        })
    );

    logSection(
        deploymentExecution?.success
            ? 'Validation-Bound Deployment Completed'
            : 'Validation-Bound Deployment Failed'
    );

    const blockedExecution =
        deploymentExecution?.success !== true &&
        deploymentExecution?.status === 'BLOCKED';

    if (blockedExecution) {
        return {
            success: false,
            boundDeploy: {
                status: 'BLOCKED',
                code: 'BOUND_DEPLOY_FAILED',
                validationId: artifact.validationId,
                artifactDigest: artifact.artifactDigest,
                packageRegenerated: false,
                message: deploymentExecution?.message || 'Bound deployment was blocked.'
            },
            boundValidationId: artifact.validationId,
            deploymentExecution,
            checkOnlyDeployment: result.checkOnlyDeployment,
            deploymentReadiness: result.deploymentReadiness,
            generatedWorkspace: {
                ...result.generatedWorkspace,
                workspacePath: artifact.canonicalWorkspaceRoot
            },
            generatedManifest: result.generatedManifest,
            generatedDeploymentPackage: result.generatedDeploymentPackage,
            deploymentHistory
        };
    }

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
        checkOnlyDeployment: result.checkOnlyDeployment,
        deploymentReadiness: result.deploymentReadiness,
        generatedWorkspace: {
            ...result.generatedWorkspace,
            workspacePath: artifact.canonicalWorkspaceRoot
        },
        generatedManifest: result.generatedManifest,
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

function setRunDeployAfterOptionalSnapshotForTests(fn) {
    if (typeof fn !== 'function') {
        throw new Error(
            'setRunDeployAfterOptionalSnapshotForTests requires a function'
        );
    }
    runDeployAfterOptionalSnapshot = fn;
}

function resetRunDeployAfterOptionalSnapshotForTests() {
    runDeployAfterOptionalSnapshot =
        destinationSnapshotCaptureService.runDeployAfterOptionalSnapshot.bind(
            destinationSnapshotCaptureService
        );
}

function setResolveVerifiedDestinationOrgIdForTests(fn) {
    if (typeof fn !== 'function') {
        throw new Error(
            'setResolveVerifiedDestinationOrgIdForTests requires a function'
        );
    }
    resolveVerifiedOrgId = fn;
}

function resetResolveVerifiedDestinationOrgIdForTests() {
    resolveVerifiedOrgId = resolveVerifiedDestinationOrgId;
}

module.exports = {
    resolveBoundValidationJob,
    verifyBoundDeployPreconditions,
    deployBoundValidationArtifact,
    verifyBoundDestinationIdentity,
    setRunDeploymentExecutionForTests,
    resetRunDeploymentExecutionForTests,
    setRunDeployAfterOptionalSnapshotForTests,
    resetRunDeployAfterOptionalSnapshotForTests,
    setResolveVerifiedDestinationOrgIdForTests,
    resetResolveVerifiedDestinationOrgIdForTests
};
