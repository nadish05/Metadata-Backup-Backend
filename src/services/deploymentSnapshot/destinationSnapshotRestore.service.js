'use strict';

const {
    SNAPSHOT_STATUS,
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./snapshot.types');
const { SnapshotNotFoundError, SnapshotIntegrityError, SnapshotValidationError } = require('./snapshot.errors');
const { isCaptureAllowlisted } = require('./destinationSnapshotMapper.service');
const {
    compareDestinationToSnapshot,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const { isDurableSnapshotStorageReady } = require('./snapshotStorage.config');
const { getSharedSnapshotAccess } = require('./snapshotAccess.service');
const { isSnapshotRollbackEnabled } = require('./snapshotRollback.flag');
const { ROLLBACK_CODE, RollbackBlockedError } = require('./snapshotRestore.errors');
const {
    buildRestoreWorkspace,
    deleteRestoreWorkspace
} = require('./restoreWorkspace.service');
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
    resolveVerifiedDestinationOrgId,
    orgIdsMatch
} = require('../deploymentOrgLock/destinationOrgIdentity.service');
const {
    OPERATION_TYPE
} = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    OrgLockBusyError,
    OrgLockStoreUnavailableError,
    OrgLockIdentityError,
    OrgLockFenceError,
    OrgLockOwnershipError
} = require('../deploymentOrgLock/deploymentOrgLock.errors');
const { retrieveDestinationMember } = require('./destinationMetadataRetriever.service');
const { generateManifest } = require('../packageXml.service');
const { runCheckOnlyDeployment } = require('../checkOnlyDeployment.service');
const { isCheckOnlySuccess } = require('../deploymentCheckOnlyGate.service');
const { runDeploymentExecution } = require('../deploymentExecution.service');

function block(code, message, extra = {}) {
    return {
        blocked: true,
        success: false,
        code,
        message,
        snapshotId: extra.snapshotId || null,
        drift: extra.drift || null,
        checkOnlyDeployment: extra.checkOnlyDeployment || null,
        deploymentExecution: extra.deploymentExecution || null,
        generatedWorkspace: extra.generatedWorkspace || null,
        historyId: extra.historyId || null,
        lockBusy: extra.lockBusy === true
    };
}

function successResult(extra = {}) {
    return {
        blocked: false,
        success: true,
        code: null,
        message: extra.message || 'Rollback restore completed.',
        snapshotId: extra.snapshotId || null,
        drift: extra.drift || null,
        checkOnlyDeployment: extra.checkOnlyDeployment || null,
        deploymentExecution: extra.deploymentExecution || null,
        generatedWorkspace: extra.generatedWorkspace || null,
        historyId: extra.historyId || null,
        lockBusy: false
    };
}

function memberKey(member) {
    return `${member.metadataType}:${member.metadataName}`;
}

function assertRollbackMembers(members) {
    if (!Array.isArray(members) || members.length === 0) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE,
            'Rollback snapshot has no members.'
        );
    }

    for (const member of members) {
        if (!isCaptureAllowlisted(member.metadataType)) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.UNSUPPORTED_METADATA,
                `Rollback metadata type is not supported: ${member.metadataType}.`
            );
        }

        if (member.changeClass === CHANGE_CLASS.NEW) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.NEW_MEMBER_PRESENT,
                `Rollback cannot restore NEW member ${memberKey(member)}.`
            );
        }

        if (member.changeClass !== CHANGE_CLASS.MODIFIED) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.MEMBER_NOT_MODIFIED,
                `Rollback requires MODIFIED members; ${memberKey(member)} is ${member.changeClass}.`
            );
        }

        if (
            member.captureStatus !== MEMBER_CAPTURE_STATUS.COMPLETE ||
            !member.destinationBeforeHash ||
            !member.expectedAfterHash ||
            !member.artifactId
        ) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE,
                `Rollback member ${memberKey(member)} is missing destination-before, expected-after, or artifact data.`
            );
        }
    }
}

function createDestinationSnapshotRestoreService(dependencies = {}) {
    const isEnabled =
        dependencies.isSnapshotRollbackEnabled || isSnapshotRollbackEnabled;
    const isDurableReady =
        dependencies.isDurableSnapshotStorageReady ||
        isDurableSnapshotStorageReady;
    const resolveAccess =
        dependencies.getSharedSnapshotAccess || getSharedSnapshotAccess;
    const isLockEnabled =
        dependencies.isDeploymentOrgLockEnabled || isDeploymentOrgLockEnabled;
    const resolveLockService =
        dependencies.getOrgLockService || getSharedOrgLockService;
    const resolveIdentity =
        dependencies.resolveVerifiedDestinationOrgId ||
        resolveVerifiedDestinationOrgId;
    const startHeartbeat =
        dependencies.startLockHeartbeat || startLockHeartbeat;
    const createLockOwnerId = dependencies.createOwnerId || createOwnerId;
    const retrieveMember =
        dependencies.retrieveDestinationMember || retrieveDestinationMember;
    const checkOnlyFn =
        dependencies.runCheckOnlyDeployment || runCheckOnlyDeployment;
    const executeFn =
        dependencies.runDeploymentExecution || runDeploymentExecution;
    const historyService = dependencies.historyService || null;
    const buildWorkspace =
        dependencies.buildRestoreWorkspace || buildRestoreWorkspace;
    const deleteWorkspace =
        dependencies.deleteRestoreWorkspace || deleteRestoreWorkspace;

    function resolveCapture() {
        if (dependencies.captureService) {
            return dependencies.captureService;
        }

        return resolveAccess().captureService;
    }

    async function recordHistory(args, snapshot, result) {
        if (!historyService || typeof historyService.createHistory !== 'function') {
            return null;
        }

        try {
            let rollbackOfHistoryId = args.rollbackOfHistoryId || null;

            if (
                !rollbackOfHistoryId &&
                typeof historyService.findBySnapshotId === 'function'
            ) {
                const original = historyService.findBySnapshotId(
                    snapshot.snapshotId
                );
                rollbackOfHistoryId = original?.historyId || null;
            }

            const historyId = historyService.createHistory({
                deploymentPackage: {
                    deploymentMode: 'DEPLOY',
                    sourceOrgId: snapshot.sourceOrgId,
                    destinationOrgId: snapshot.destinationOrgId,
                    sourceBranch: snapshot.sourceBranch,
                    destinationBranch: snapshot.destinationBranch
                },
                deploymentReadiness: {
                    overallStatus: result.blocked ? 'BLOCKED' : 'READY',
                    canDeploy: !result.blocked
                },
                operationType: OPERATION_TYPE.ROLLBACK,
                rollbackOfSnapshotId: snapshot.snapshotId,
                rollbackOfHistoryId
            });

            if (historyId && typeof historyService.completeHistory === 'function') {
                historyService.completeHistory(historyId, {
                    deploymentMode: 'DEPLOY',
                    destinationOrgId: snapshot.destinationOrgId,
                    sourceOrgId: snapshot.sourceOrgId,
                    generatedWorkspace: result.generatedWorkspace,
                    deploymentResult:
                        result.deploymentExecution ||
                        result.checkOnlyDeployment || {
                            status: result.blocked ? 'BLOCKED' : 'Succeeded',
                            success: !result.blocked,
                            message: result.message
                        }
                });
            }

            return historyId || null;
        } catch (error) {
            console.error('ROLLBACK_HISTORY_PERSISTENCE_FAILURE');
            console.error(error?.message || error);
            return null;
        }
    }

    async function runRollback(args = {}) {
        const snapshotId = args.snapshotId || null;

        if (!isEnabled()) {
            return block(
                ROLLBACK_CODE.DISABLED,
                'Rollback is disabled. Set SNAPSHOT_ROLLBACK_ENABLED=true to evaluate restore.',
                { snapshotId }
            );
        }

        if (!isDurableReady()) {
            return block(
                ROLLBACK_CODE.STORAGE_UNAVAILABLE,
                'Durable snapshot storage is not configured.',
                { snapshotId }
            );
        }

        if (!snapshotId) {
            return block(
                ROLLBACK_CODE.SNAPSHOT_NOT_FOUND,
                'snapshotId is required.',
                { snapshotId }
            );
        }

        const captureService = resolveCapture();
        let snapshot;
        let members;

        try {
            snapshot = await captureService.getSnapshot(snapshotId);
            members = await captureService.getMembers(snapshotId);
        } catch (error) {
            if (
                error instanceof SnapshotNotFoundError ||
                error instanceof SnapshotValidationError
            ) {
                return block(
                    ROLLBACK_CODE.SNAPSHOT_NOT_FOUND,
                    error.message,
                    { snapshotId }
                );
            }

            return block(
                ROLLBACK_CODE.SNAPSHOT_NOT_FOUND,
                error.message || 'Snapshot could not be loaded.',
                { snapshotId }
            );
        }

        if (!snapshot) {
            return block(
                ROLLBACK_CODE.SNAPSHOT_NOT_FOUND,
                `Snapshot not found: ${snapshotId}`,
                { snapshotId }
            );
        }

        if (snapshot.status !== SNAPSHOT_STATUS.SEALED) {
            return block(
                ROLLBACK_CODE.SNAPSHOT_NOT_SEALED,
                `Rollback requires a SEALED snapshot (status=${snapshot.status}).`,
                { snapshotId }
            );
        }

        if (snapshot.rollbackEligible !== true) {
            return block(
                ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE,
                'Snapshot is not rollback eligible.',
                { snapshotId }
            );
        }

        try {
            assertRollbackMembers(members);
        } catch (error) {
            if (error instanceof RollbackBlockedError) {
                return block(error.code, error.message, { snapshotId });
            }

            throw error;
        }

        let integrity;

        try {
            integrity = await captureService.verifySnapshotIntegrity(snapshotId);
        } catch (error) {
            if (error instanceof SnapshotIntegrityError) {
                const missing = /missing/i.test(error.message);
                return block(
                    missing
                        ? ROLLBACK_CODE.ARTIFACT_MISSING
                        : ROLLBACK_CODE.ARTIFACT_HASH_MISMATCH,
                    error.message,
                    { snapshotId }
                );
            }

            return block(
                ROLLBACK_CODE.INTEGRITY_MISMATCH,
                error.message || 'Snapshot integrity verification failed.',
                { snapshotId }
            );
        }

        if (
            !snapshot.overallIntegrityHash ||
            integrity.overallIntegrityHash !== snapshot.overallIntegrityHash
        ) {
            return block(
                ROLLBACK_CODE.INTEGRITY_MISMATCH,
                'Recomputed snapshot integrity hash does not match the sealed hash.',
                { snapshotId }
            );
        }

        let verifiedOrgId;

        try {
            verifiedOrgId = await resolveIdentity({
                refreshToken: args.refreshToken,
                instanceUrl: args.instanceUrl,
                requestedOrgId: args.destinationOrgId || snapshot.destinationOrgId
            });
        } catch (error) {
            if (error instanceof OrgLockIdentityError) {
                return block(
                    ROLLBACK_CODE.IDENTITY_FAILURE,
                    error.message,
                    { snapshotId }
                );
            }

            return block(
                ROLLBACK_CODE.IDENTITY_FAILURE,
                error.message || 'Destination org identity verification failed.',
                { snapshotId }
            );
        }

        if (!orgIdsMatch(verifiedOrgId, snapshot.destinationOrgId)) {
            return block(
                ROLLBACK_CODE.DESTINATION_MISMATCH,
                'Verified destination org does not match the sealed snapshot destination org.',
                { snapshotId }
            );
        }

        if (!isLockEnabled()) {
            return block(
                ROLLBACK_CODE.LOCK_DISABLED,
                'Rollback requires DEPLOYMENT_ORG_LOCK_ENABLED=true.',
                { snapshotId }
            );
        }

        let lockHandle = null;
        let stopHeartbeat = () => {};
        let generatedWorkspace = null;
        let outcome = null;

        try {
            const lockService = resolveLockService();
            lockHandle = lockService.acquire({
                destinationOrgId: verifiedOrgId,
                ownerId: createLockOwnerId(),
                operationType: OPERATION_TYPE.ROLLBACK,
                historyId: args.historyId || null,
                snapshotId: snapshot.snapshotId
            });

            stopHeartbeat = startHeartbeat({
                lockService,
                destinationOrgId: lockHandle.destinationOrgId,
                ownerId: lockHandle.ownerId,
                leaseGeneration: lockHandle.leaseGeneration
            });

            const drift = [];

            for (const member of members) {
                let retrieved;

                try {
                    retrieved = await retrieveMember({
                        refreshToken: args.refreshToken,
                        instanceUrl: args.instanceUrl,
                        metadataType: member.metadataType,
                        metadataName: member.metadataName,
                        sourceApiVersion: args.deploymentApiVersion || null
                    });
                } catch (error) {
                    throw new RollbackBlockedError(
                        ROLLBACK_CODE.DESTINATION_RETRIEVE_FAILED,
                        `Destination retrieve failed for ${memberKey(member)}.`
                    );
                }

                if (!retrieved?.artifactBytes || !retrieved.artifactBytes.length) {
                    throw new RollbackBlockedError(
                        ROLLBACK_CODE.DESTINATION_RETRIEVE_FAILED,
                        `Destination retrieve returned no artifact for ${memberKey(member)}.`
                    );
                }

                const currentDestinationHash = hashBytes(retrieved.artifactBytes);
                const comparison = compareDestinationToSnapshot({
                    destinationBeforeHash: member.destinationBeforeHash,
                    expectedAfterHash: member.expectedAfterHash,
                    currentDestinationHash
                });

                drift.push({
                    snapshotId: snapshot.snapshotId,
                    metadataType: member.metadataType,
                    metadataName: member.metadataName,
                    classification: comparison.classification,
                    destinationBeforeHash: member.destinationBeforeHash,
                    expectedAfterHash: member.expectedAfterHash,
                    currentHash: currentDestinationHash
                });
            }

            const drifted = drift.filter(
                (entry) =>
                    entry.classification !==
                    DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );

            if (drifted.length) {
                outcome = block(
                    ROLLBACK_CODE.DRIFT_DETECTED,
                    'Rollback blocked because destination state does not match expected-after for every member.',
                    { snapshotId, drift }
                );
                outcome.historyId = await recordHistory(args, snapshot, outcome);
                return outcome;
            }

            generatedWorkspace = await buildWorkspace({
                snapshot,
                members,
                getArtifact: (id, artifactId) =>
                    captureService.getArtifact(id, artifactId),
                apiVersion: args.deploymentApiVersion || null
            });

            const generatedManifest =
                generatedWorkspace.generatedManifest ||
                generateManifest(
                    generatedWorkspace.generatedDeploymentPackage,
                    args.deploymentApiVersion
                        ? { deploymentApiVersion: args.deploymentApiVersion }
                        : {}
                );

            const checkOnlyDeployment = await checkOnlyFn({
                generatedWorkspace,
                generatedManifest,
                refreshToken: args.refreshToken,
                instanceUrl: args.instanceUrl,
                deploymentApiVersion: args.deploymentApiVersion || null
            });

            if (!isCheckOnlySuccess(checkOnlyDeployment)) {
                outcome = block(
                    ROLLBACK_CODE.CHECK_ONLY_FAILED,
                    checkOnlyDeployment?.message ||
                        'Rollback check-only validation failed.',
                    {
                        snapshotId,
                        drift,
                        checkOnlyDeployment,
                        generatedWorkspace
                    }
                );
                outcome.historyId = await recordHistory(args, snapshot, outcome);
                return outcome;
            }

            resolveLockService().assertHeld({
                destinationOrgId: lockHandle.destinationOrgId,
                ownerId: lockHandle.ownerId,
                leaseGeneration: lockHandle.leaseGeneration
            });

            const deploymentExecution = await executeFn({
                generatedWorkspace,
                generatedManifest,
                deploymentReadiness: {
                    canDeploy: true,
                    overallStatus: 'READY'
                },
                priorCheckOnlyDeployment: checkOnlyDeployment,
                refreshToken: args.refreshToken,
                instanceUrl: args.instanceUrl,
                deploymentApiVersion: args.deploymentApiVersion || null
            }).catch((error) => {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.EXECUTION_FAILED,
                    error.message || 'Rollback Salesforce deployment failed.'
                );
            });

            if (
                !deploymentExecution ||
                deploymentExecution.success === false ||
                String(deploymentExecution.status || '').toUpperCase() ===
                    'BLOCKED' ||
                String(deploymentExecution.status || '').toUpperCase() ===
                    'FAILED'
            ) {
                outcome = block(
                    ROLLBACK_CODE.EXECUTION_FAILED,
                    deploymentExecution?.message ||
                        'Rollback Salesforce deployment failed.',
                    {
                        snapshotId,
                        drift,
                        checkOnlyDeployment,
                        deploymentExecution,
                        generatedWorkspace
                    }
                );
                outcome.historyId = await recordHistory(args, snapshot, outcome);
                return outcome;
            }

            outcome = successResult({
                snapshotId,
                drift,
                checkOnlyDeployment,
                deploymentExecution,
                generatedWorkspace
            });
            outcome.historyId = await recordHistory(args, snapshot, outcome);
            return outcome;
        } catch (error) {
            if (error instanceof OrgLockBusyError) {
                return block(ROLLBACK_CODE.LOCK_BUSY, error.message, {
                    snapshotId,
                    lockBusy: true
                });
            }

            if (error instanceof OrgLockStoreUnavailableError) {
                return block(ROLLBACK_CODE.LOCK_UNAVAILABLE, error.message, {
                    snapshotId
                });
            }

            if (
                error instanceof OrgLockFenceError ||
                error instanceof OrgLockOwnershipError
            ) {
                return block(ROLLBACK_CODE.LOCK_FENCE, error.message, {
                    snapshotId
                });
            }

            if (error instanceof RollbackBlockedError) {
                const blocked = block(error.code, error.message, {
                    snapshotId,
                    generatedWorkspace
                });
                blocked.historyId = await recordHistory(
                    args,
                    snapshot,
                    blocked
                );
                return blocked;
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
                    console.error('ROLLBACK_LOCK_RELEASE_FAILED');
                    console.error(releaseError?.message || releaseError);
                }
            }

            if (generatedWorkspace?.workspacePath) {
                try {
                    await deleteWorkspace(generatedWorkspace.workspacePath);
                    if (outcome) {
                        outcome.generatedWorkspace = {
                            ...generatedWorkspace,
                            status: 'CLEANED'
                        };
                    }
                } catch (cleanupError) {
                    if (outcome) {
                        outcome.workspaceCleanupFailed = true;
                    }
                    void cleanupError;
                }
            }
        }
    }

    return {
        runRollback
    };
}

const defaultRestore = createDestinationSnapshotRestoreService();

module.exports = {
    createDestinationSnapshotRestoreService,
    runRollback: defaultRestore.runRollback
};
