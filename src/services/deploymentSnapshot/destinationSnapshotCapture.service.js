'use strict';

const { CHANGE_CLASS, SNAPSHOT_STATUS } = require('./snapshot.types');
const { getSharedSnapshotAccess } = require('./snapshotAccess.service');
const {
    isDurableSnapshotStorageReady,
    DURABLE_STORAGE_UNAVAILABLE_MESSAGE
} = require('./snapshotStorage.config');
const {
    isSnapshotCaptureOnDeployEnabled
} = require('./snapshotCapture.flag');
const {
    collectFinalDeploymentMembers,
    isCaptureAllowlisted,
    mapExistenceToChangeClass,
    buildUnsupportedReason,
    buildUnknownReason,
    buildMissingArtifactReason
} = require('./destinationSnapshotMapper.service');
const {
    collectExpectedAfterArtifact,
    buildMissingExpectedAfterReason
} = require('./expectedAfterArtifact.service');
const {
    retrieveDestinationMember
} = require('./destinationMetadataRetriever.service');
const {
    buildDestinationInventory,
    getState,
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    refreshAccessToken,
    buildBlockedResult
} = require('../checkOnlyDeployment.service');
const {
    isDeploymentOrgLockEnabled
} = require('../deploymentOrgLock/deploymentOrgLock.flag');
const {
    getSharedOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.resolver');
const {
    createOwnerId
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const { startLockHeartbeat } = require('../deploymentOrgLock/deploymentOrgLock.heartbeat');
const {
    resolveVerifiedDestinationOrgId
} = require('../deploymentOrgLock/destinationOrgIdentity.service');
const {
    OrgLockBusyError,
    OrgLockStoreUnavailableError,
    OrgLockIdentityError,
    OrgLockFenceError,
    OrgLockOwnershipError
} = require('../deploymentOrgLock/deploymentOrgLock.errors');
const { OPERATION_TYPE } = require('../deploymentOrgLock/deploymentOrgLock.types');
const { logLockEvent } = require('../deploymentOrgLock/deploymentOrgLock.log');

function fail(message, snapshot = null) {
    return {
        ok: false,
        message,
        snapshot
    };
}

function createDestinationSnapshotCaptureService(dependencies = {}) {
    const collectExpectedAfter =
        dependencies.collectExpectedAfterArtifact ||
        collectExpectedAfterArtifact;
    const inventoryBuilder =
        dependencies.buildDestinationInventory || buildDestinationInventory;
    const inventoryState = dependencies.getState || getState;
    const retrieveMember =
        dependencies.retrieveDestinationMember || retrieveDestinationMember;
    const refreshTokenFn =
        dependencies.refreshAccessToken || refreshAccessToken;
    const isEnabled =
        dependencies.isSnapshotCaptureOnDeployEnabled ||
        isSnapshotCaptureOnDeployEnabled;
    const isDurableReady =
        dependencies.isDurableSnapshotStorageReady ||
        isDurableSnapshotStorageReady;
    const isLockEnabled =
        dependencies.isDeploymentOrgLockEnabled ||
        isDeploymentOrgLockEnabled;
    const resolveLockService =
        dependencies.getOrgLockService || getSharedOrgLockService;
    const resolveIdentity =
        dependencies.resolveVerifiedDestinationOrgId ||
        resolveVerifiedDestinationOrgId;
    const startHeartbeat =
        dependencies.startLockHeartbeat || startLockHeartbeat;
    const createLockOwnerId = dependencies.createOwnerId || createOwnerId;
    const enforceDurableCapture =
        dependencies.enforceDurableCapture !== undefined
            ? dependencies.enforceDurableCapture
            : !dependencies.captureService;

    function resolveCaptureService() {
        return (
            dependencies.captureService ||
            getSharedSnapshotAccess().captureService
        );
    }

    async function captureAndSealForDeploy({
        destinationOrgId,
        sourceOrgId = null,
        historyId = null,
        sourceBranch = null,
        destinationBranch = null,
        generatedDeploymentPackage,
        generatedWorkspace,
        refreshToken,
        instanceUrl,
        deploymentApiVersion = null
    } = {}) {
        if (!destinationOrgId) {
            return fail(
                'Destination snapshot capture failed: destinationOrgId is required.'
            );
        }

        if (enforceDurableCapture && !isDurableReady()) {
            return fail(DURABLE_STORAGE_UNAVAILABLE_MESSAGE);
        }

        const finalMembers = collectFinalDeploymentMembers(
            generatedDeploymentPackage
        );

        if (!finalMembers.length) {
            return {
                ok: true,
                skipped: true,
                snapshot: null,
                message: 'No final deployment members to snapshot.'
            };
        }

        let accessToken = null;
        let resolvedInstanceUrl = instanceUrl;

        try {
            const tokenResult = await refreshTokenFn(refreshToken);
            accessToken = tokenResult.accessToken;
            resolvedInstanceUrl = tokenResult.instanceUrl || instanceUrl;
        } catch (error) {
            return fail(
                'Destination snapshot capture failed: unable to authenticate with destination org.'
            );
        }

        let inventory = new Map();

        try {
            const inventoryResult = await inventoryBuilder({
                items: finalMembers,
                accessToken,
                instanceUrl: resolvedInstanceUrl
            });
            inventory = inventoryResult.inventory;
        } catch (error) {
            const first = finalMembers[0];
            return fail(
                buildUnknownReason(
                    first.metadataType,
                    first.metadataName,
                    'fresh destination inventory failed.'
                )
            );
        }

        const captureMembers = [];

        for (const member of finalMembers) {
            if (!isCaptureAllowlisted(member.metadataType)) {
                return fail(
                    buildUnsupportedReason(
                        member.metadataType,
                        member.metadataName
                    )
                );
            }

            const existence = inventoryState(
                inventory,
                member.metadataType,
                member.metadataName
            );
            const changeClass = mapExistenceToChangeClass(existence);

            if (changeClass === CHANGE_CLASS.UNKNOWN) {
                return fail(
                    buildUnknownReason(member.metadataType, member.metadataName)
                );
            }

            if (changeClass === CHANGE_CLASS.NEW) {
                captureMembers.push({
                    metadataType: member.metadataType,
                    metadataName: member.metadataName,
                    filePath: member.filePath,
                    changeClass: CHANGE_CLASS.NEW
                });
                continue;
            }

            let expectedAfter;

            try {
                expectedAfter = await collectExpectedAfter({
                    workspacePath: generatedWorkspace?.workspacePath,
                    member
                });
            } catch (error) {
                return fail(
                    error.message ||
                        buildMissingExpectedAfterReason(
                            member.metadataType,
                            member.metadataName
                        )
                );
            }

            if (!expectedAfter?.expectedAfterHash) {
                return fail(
                    buildMissingExpectedAfterReason(
                        member.metadataType,
                        member.metadataName
                    )
                );
            }

            let retrieved;

            try {
                retrieved = await retrieveMember({
                    refreshToken,
                    instanceUrl: resolvedInstanceUrl,
                    metadataType: member.metadataType,
                    metadataName: member.metadataName,
                    sourceApiVersion: deploymentApiVersion
                });
            } catch (error) {
                return fail(
                    error.message ||
                        buildMissingArtifactReason(
                            member.metadataType,
                            member.metadataName
                        )
                );
            }

            if (!retrieved?.artifactBytes || !retrieved.artifactBytes.length) {
                return fail(
                    buildMissingArtifactReason(
                        member.metadataType,
                        member.metadataName
                    )
                );
            }

            captureMembers.push({
                metadataType: member.metadataType,
                metadataName: member.metadataName,
                filePath: member.filePath,
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: retrieved.artifactBytes,
                expectedAfterHash: expectedAfter.expectedAfterHash
            });
        }

        try {
            const captureService = resolveCaptureService();
            const ready = await captureService.captureSnapshot({
                deploymentContext: {
                    destinationOrgId,
                    sourceOrgId,
                    deploymentId: historyId,
                    sourceBranch,
                    destinationBranch
                },
                members: captureMembers
            });

            if (ready.status !== SNAPSHOT_STATUS.READY) {
                return fail(
                    'Destination snapshot capture failed: snapshot did not become READY.',
                    ready
                );
            }

            const sealed = await captureService.sealSnapshot(ready.snapshotId);

            if (sealed.status !== SNAPSHOT_STATUS.SEALED) {
                return fail(
                    'Destination snapshot capture failed: snapshot did not seal.',
                    sealed
                );
            }

            return {
                ok: true,
                snapshot: sealed
            };
        } catch (error) {
            return fail(
                error.message || 'Destination snapshot capture failed.'
            );
        }
    }

    function blockExecution(message) {
        return buildBlockedResult(message, {
            mode: 'execution',
            executionMode: 'deploy'
        });
    }

    async function runDeployAfterOptionalSnapshot({
        shouldDeploy,
        captureArgs,
        runDeploymentExecution,
        afterLockedExecution = null
    }) {
        if (!shouldDeploy) {
            return {
                deploymentExecution: undefined,
                snapshot: null,
                snapshotBlocked: false
            };
        }

        if (!isLockEnabled()) {
            if (!isEnabled()) {
                return {
                    deploymentExecution: await runDeploymentExecution(),
                    snapshot: null,
                    snapshotBlocked: false
                };
            }

            if (enforceDurableCapture && !isDurableReady()) {
                return {
                    deploymentExecution: blockExecution(
                        DURABLE_STORAGE_UNAVAILABLE_MESSAGE
                    ),
                    snapshot: null,
                    snapshotBlocked: true
                };
            }

            const capture = await captureAndSealForDeploy(captureArgs);

            if (!capture.ok) {
                return {
                    deploymentExecution: blockExecution(capture.message),
                    snapshot: capture.snapshot || null,
                    snapshotBlocked: true
                };
            }

            const deploymentExecution = await runDeploymentExecution();

            if (typeof afterLockedExecution === 'function') {
                await afterLockedExecution({
                    snapshot: capture.snapshot || null,
                    deploymentExecution
                });
            }

            return {
                deploymentExecution,
                snapshot: capture.snapshot || null,
                snapshotBlocked: false
            };
        }

        let lockHandle = null;
        let stopHeartbeat = () => {};

        try {
            const verifiedOrgId = await resolveIdentity({
                refreshToken: captureArgs?.refreshToken,
                instanceUrl: captureArgs?.instanceUrl,
                requestedOrgId: captureArgs?.destinationOrgId ?? null
            });

            const lockService = resolveLockService();
            lockHandle = lockService.acquire({
                destinationOrgId: verifiedOrgId,
                ownerId: createLockOwnerId(),
                operationType: OPERATION_TYPE.DEPLOY,
                historyId: captureArgs?.historyId ?? null,
                snapshotId: null
            });

            stopHeartbeat = startHeartbeat({
                lockService,
                destinationOrgId: lockHandle.destinationOrgId,
                ownerId: lockHandle.ownerId,
                leaseGeneration: lockHandle.leaseGeneration
            });

            const lockedCaptureArgs = {
                ...captureArgs,
                destinationOrgId: verifiedOrgId
            };

            let snapshot = null;

            if (isEnabled()) {
                if (enforceDurableCapture && !isDurableReady()) {
                    return {
                        deploymentExecution: blockExecution(
                            DURABLE_STORAGE_UNAVAILABLE_MESSAGE
                        ),
                        snapshot: null,
                        snapshotBlocked: true
                    };
                }

                const capture = await captureAndSealForDeploy(lockedCaptureArgs);

                if (!capture.ok) {
                    return {
                        deploymentExecution: blockExecution(capture.message),
                        snapshot: capture.snapshot || null,
                        snapshotBlocked: true
                    };
                }

                snapshot = capture.snapshot || null;
            }

            lockService.assertHeld({
                destinationOrgId: lockHandle.destinationOrgId,
                ownerId: lockHandle.ownerId,
                leaseGeneration: lockHandle.leaseGeneration
            });

            const deploymentExecution = await runDeploymentExecution();

            if (typeof afterLockedExecution === 'function') {
                await afterLockedExecution({
                    snapshot,
                    deploymentExecution
                });
            }

            return {
                deploymentExecution,
                snapshot,
                snapshotBlocked: false
            };
        } catch (error) {
            if (error instanceof OrgLockBusyError) {
                logLockEvent('LOCK_BUSY', {
                    destinationOrgId: captureArgs?.destinationOrgId ?? null,
                    operationType: OPERATION_TYPE.DEPLOY
                });

                return {
                    deploymentExecution: blockExecution(error.message),
                    snapshot: null,
                    snapshotBlocked: true,
                    lockBusy: true
                };
            }

            if (
                error instanceof OrgLockStoreUnavailableError ||
                error instanceof OrgLockIdentityError ||
                error instanceof OrgLockFenceError ||
                error instanceof OrgLockOwnershipError
            ) {
                return {
                    deploymentExecution: blockExecution(error.message),
                    snapshot: null,
                    snapshotBlocked: true
                };
            }

            throw error;
        } finally {
            stopHeartbeat();

            if (lockHandle) {
                try {
                    resolveLockService().release({
                        destinationOrgId: lockHandle.destinationOrgId,
                        ownerId: lockHandle.ownerId,
                        leaseGeneration: lockHandle.leaseGeneration
                    });
                } catch (releaseError) {
                    logLockEvent('LOCK_RELEASE_FAILED', {
                        destinationOrgId: lockHandle.destinationOrgId,
                        ownerId: lockHandle.ownerId,
                        leaseGeneration: lockHandle.leaseGeneration
                    });
                    void releaseError;
                }
            }
        }
    }

    return {
        captureAndSealForDeploy,
        runDeployAfterOptionalSnapshot
    };
}

const defaultOrchestrator = createDestinationSnapshotCaptureService();

module.exports = {
    createDestinationSnapshotCaptureService,
    captureAndSealForDeploy: defaultOrchestrator.captureAndSealForDeploy,
    runDeployAfterOptionalSnapshot:
        defaultOrchestrator.runDeployAfterOptionalSnapshot,
    isSnapshotCaptureOnDeployEnabled
};
