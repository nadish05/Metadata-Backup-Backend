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
const {
    RollbackOperationPersistenceError
} = require('./rollbackOperation.errors');
const { logRollbackOperationEvent } = require('./rollbackOperation.log');
const { getSharedRollbackOperationStore } = require('./rollbackOperation.resolver');
const {
    createRollbackOperationService,
    evaluateExistingOperation
} = require('./rollbackOperation.service');
const {
    CHECK_ONLY_STATUS,
    ROLLBACK_OPERATION_STATUS
} = require('./rollbackOperation.types');

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
        lockBusy: extra.lockBusy === true,
        operationId: extra.operationId || null,
        operationStatus: extra.operationStatus || null
    };
}

function successResult(extra = {}) {
    return {
        blocked: false,
        success: true,
        code: extra.code || null,
        message: extra.message || 'Rollback restore completed.',
        snapshotId: extra.snapshotId || null,
        drift: extra.drift || null,
        checkOnlyDeployment: extra.checkOnlyDeployment || null,
        deploymentExecution: extra.deploymentExecution || null,
        generatedWorkspace: extra.generatedWorkspace || null,
        historyId: extra.historyId || null,
        lockBusy: false,
        operationId: extra.operationId || null,
        operationStatus: extra.operationStatus || ROLLBACK_OPERATION_STATUS.SUCCEEDED
    };
}

function withOperation(result, operation) {
    if (!operation) {
        return result;
    }

    result.operationId = operation.operationId;
    result.operationStatus = operation.status;
    return result;
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

function extractSalesforceDeploymentId(mappedResult) {
    return (
        mappedResult?.deploymentId ||
        mappedResult?.id ||
        mappedResult?.salesforceDeploymentId ||
        null
    );
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
    const resolveOperationStore =
        dependencies.getRollbackOperationStore ||
        getSharedRollbackOperationStore;
    const operationService =
        dependencies.rollbackOperationService ||
        createRollbackOperationService({
            getStore: resolveOperationStore
        });

    function resolveCapture() {
        if (dependencies.captureService) {
            return dependencies.captureService;
        }

        return resolveAccess().captureService;
    }

    async function recordHistory(args, snapshot, result, operation) {
        if (!historyService || typeof historyService.createHistory !== 'function') {
            return null;
        }

        try {
            let rollbackOfHistoryId =
                args.rollbackOfHistoryId ||
                operation?.rollbackOfHistoryId ||
                null;

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
                const operationStatus = operation?.status || result.operationStatus;
                const unknown =
                    operationStatus === ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT ||
                    result.code === ROLLBACK_CODE.RESULT_UNKNOWN ||
                    result.code === ROLLBACK_CODE.RESULT_PERSISTENCE_UNKNOWN;

                historyService.completeHistory(historyId, {
                    deploymentMode: 'DEPLOY',
                    destinationOrgId: snapshot.destinationOrgId,
                    sourceOrgId: snapshot.sourceOrgId,
                    generatedWorkspace: result.generatedWorkspace,
                    deploymentResult: unknown
                        ? {
                              status: 'UNKNOWN_RESULT',
                              success: null,
                              message: result.message,
                              deploymentId:
                                  operation?.salesforceDeploymentId ||
                                  extractSalesforceDeploymentId(
                                      result.deploymentExecution
                                  )
                          }
                        : result.deploymentExecution ||
                          result.checkOnlyDeployment || {
                              status: result.blocked ? 'BLOCKED' : 'Succeeded',
                              success: !result.blocked,
                              message: result.message,
                              deploymentId: operation?.salesforceDeploymentId || null
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

    async function persistFailed(operation, extra = {}) {
        if (!operation) {
            return operation;
        }

        try {
            return await operationService.markTerminal(operation.operationId, {
                status: ROLLBACK_OPERATION_STATUS.FAILED,
                ...extra
            });
        } catch (error) {
            console.error('ROLLBACK_OPERATION_PERSISTENCE_FAILURE');
            console.error(error?.message || error);
            return operation;
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

        let existing;

        try {
            existing = await operationService.findLatestForSnapshot(
                snapshot.destinationOrgId,
                snapshot.snapshotId
            );
        } catch (error) {
            return block(
                ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE,
                error.message || 'Rollback operation store is unavailable.',
                { snapshotId }
            );
        }

        const decision = evaluateExistingOperation(existing);

        if (decision.action === 'BLOCK_IN_PROGRESS') {
            logRollbackOperationEvent('ROLLBACK_OPERATION_DUPLICATE', existing);
            return withOperation(
                block(
                    ROLLBACK_CODE.ALREADY_IN_PROGRESS,
                    'A rollback for this snapshot is already in progress.',
                    { snapshotId }
                ),
                existing
            );
        }

        if (decision.action === 'BLOCK_COMPLETED') {
            logRollbackOperationEvent('ROLLBACK_OPERATION_DUPLICATE', existing);
            return withOperation(
                block(
                    ROLLBACK_CODE.ALREADY_COMPLETED,
                    'A rollback for this snapshot already completed successfully.',
                    { snapshotId }
                ),
                existing
            );
        }

        if (decision.action === 'BLOCK_UNKNOWN') {
            logRollbackOperationEvent('ROLLBACK_OPERATION_DUPLICATE', existing);
            return withOperation(
                block(
                    ROLLBACK_CODE.RESULT_UNKNOWN,
                    'A prior rollback for this snapshot has an unknown Salesforce result and must be reconciled before retry.',
                    { snapshotId }
                ),
                existing
            );
        }

        let operation = null;
        let lockHandle = null;
        let stopHeartbeat = () => {};
        let generatedWorkspace = null;
        let outcome = null;
        let executionStarted = false;

        try {
            if (decision.action === 'RESUME') {
                operation = existing;
            } else {
                try {
                    operation = await operationService.createOperation({
                        snapshotId: snapshot.snapshotId,
                        destinationOrgId: snapshot.destinationOrgId,
                        sourceDeploymentId: args.sourceDeploymentId || null,
                        rollbackOfHistoryId: args.rollbackOfHistoryId || null,
                        retryOfOperationId:
                            decision.action === 'RETRY'
                                ? existing.operationId
                                : null
                    });
                } catch (error) {
                    if (error instanceof RollbackOperationPersistenceError) {
                        return block(
                            ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE,
                            error.message,
                            { snapshotId }
                        );
                    }

                    throw error;
                }
            }

            try {
                operation = await operationService.transitionToInProgress(
                    operation.operationId
                );
            } catch (error) {
                if (error instanceof RollbackOperationPersistenceError) {
                    return withOperation(
                        block(
                            ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE,
                            error.message,
                            { snapshotId }
                        ),
                        operation
                    );
                }

                throw error;
            }

            let verifiedOrgId;

            try {
                verifiedOrgId = await resolveIdentity({
                    refreshToken: args.refreshToken,
                    instanceUrl: args.instanceUrl,
                    requestedOrgId:
                        args.destinationOrgId || snapshot.destinationOrgId
                });
            } catch (error) {
                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.IDENTITY_FAILURE,
                    errorMessage: error.message
                });

                if (error instanceof OrgLockIdentityError) {
                    return withOperation(
                        block(
                            ROLLBACK_CODE.IDENTITY_FAILURE,
                            error.message,
                            { snapshotId }
                        ),
                        operation
                    );
                }

                return withOperation(
                    block(
                        ROLLBACK_CODE.IDENTITY_FAILURE,
                        error.message ||
                            'Destination org identity verification failed.',
                        { snapshotId }
                    ),
                    operation
                );
            }

            if (!orgIdsMatch(verifiedOrgId, snapshot.destinationOrgId)) {
                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.DESTINATION_MISMATCH,
                    errorMessage:
                        'Verified destination org does not match the sealed snapshot destination org.'
                });
                return withOperation(
                    block(
                        ROLLBACK_CODE.DESTINATION_MISMATCH,
                        'Verified destination org does not match the sealed snapshot destination org.',
                        { snapshotId }
                    ),
                    operation
                );
            }

            if (!isLockEnabled()) {
                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.LOCK_DISABLED,
                    errorMessage: 'Rollback requires DEPLOYMENT_ORG_LOCK_ENABLED=true.'
                });
                return withOperation(
                    block(
                        ROLLBACK_CODE.LOCK_DISABLED,
                        'Rollback requires DEPLOYMENT_ORG_LOCK_ENABLED=true.',
                        { snapshotId }
                    ),
                    operation
                );
            }

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

            try {
                operation = await resolveOperationStore().updateOperation(
                    operation.operationId,
                    {
                        lockOwner: lockHandle.ownerId,
                        leaseGeneration: lockHandle.leaseGeneration,
                        lockAcquiredAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    }
                );
            } catch (error) {
                void error;
            }

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
                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.DRIFT_DETECTED,
                    errorMessage:
                        'Rollback blocked because destination state does not match expected-after for every member.',
                    driftDetected: true,
                    driftSummary: `driftedMembers=${drifted.length}`
                });
                outcome = withOperation(
                    block(
                        ROLLBACK_CODE.DRIFT_DETECTED,
                        'Rollback blocked because destination state does not match expected-after for every member.',
                        { snapshotId, drift }
                    ),
                    operation
                );
                outcome.historyId = await recordHistory(
                    args,
                    snapshot,
                    outcome,
                    operation
                );
                return outcome;
            }

            try {
                generatedWorkspace = await buildWorkspace({
                    snapshot,
                    members,
                    getArtifact: (id, artifactId) =>
                        captureService.getArtifact(id, artifactId),
                    apiVersion: args.deploymentApiVersion || null
                });
            } catch (error) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.WORKSPACE_FAILED,
                    error.message || 'Rollback restore workspace failed.'
                );
            }

            let generatedManifest;

            try {
                generatedManifest =
                    generatedWorkspace.generatedManifest ||
                    generateManifest(
                        generatedWorkspace.generatedDeploymentPackage,
                        args.deploymentApiVersion
                            ? { deploymentApiVersion: args.deploymentApiVersion }
                            : {}
                    );
            } catch (error) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.PACKAGE_FAILED,
                    error.message || 'Rollback package.xml generation failed.'
                );
            }

            const checkOnlyDeployment = await checkOnlyFn({
                generatedWorkspace,
                generatedManifest,
                refreshToken: args.refreshToken,
                instanceUrl: args.instanceUrl,
                deploymentApiVersion: args.deploymentApiVersion || null
            });

            if (!isCheckOnlySuccess(checkOnlyDeployment)) {
                try {
                    await resolveOperationStore().updateOperation(
                        operation.operationId,
                        {
                            checkOnlyStatus: CHECK_ONLY_STATUS.FAILED,
                            updatedAt: new Date().toISOString()
                        }
                    );
                } catch (error) {
                    void error;
                }

                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.CHECK_ONLY_FAILED,
                    errorMessage:
                        checkOnlyDeployment?.message ||
                        'Rollback check-only validation failed.',
                    checkOnlyStatus: CHECK_ONLY_STATUS.FAILED
                });
                outcome = withOperation(
                    block(
                        ROLLBACK_CODE.CHECK_ONLY_FAILED,
                        checkOnlyDeployment?.message ||
                            'Rollback check-only validation failed.',
                        {
                            snapshotId,
                            drift,
                            checkOnlyDeployment,
                            generatedWorkspace
                        }
                    ),
                    operation
                );
                outcome.historyId = await recordHistory(
                    args,
                    snapshot,
                    outcome,
                    operation
                );
                return outcome;
            }

            try {
                await resolveOperationStore().updateOperation(
                    operation.operationId,
                    {
                        checkOnlyStatus: CHECK_ONLY_STATUS.SUCCESS,
                        updatedAt: new Date().toISOString()
                    }
                );
            } catch (error) {
                void error;
            }

            resolveLockService().assertHeld({
                destinationOrgId: lockHandle.destinationOrgId,
                ownerId: lockHandle.ownerId,
                leaseGeneration: lockHandle.leaseGeneration
            });

            try {
                operation = await operationService.markExecutionStarted(
                    operation.operationId
                );
            } catch (error) {
                return withOperation(
                    block(
                        ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE,
                        error.message ||
                            'Rollback operation state could not be persisted before Salesforce execution.',
                        { snapshotId }
                    ),
                    operation
                );
            }

            executionStarted = true;

            let deploymentExecution;

            try {
                deploymentExecution = await executeFn({
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
                });
            } catch (error) {
                const classified =
                    operationService.classifyExecutionException(
                        error,
                        executionStarted
                    );

                try {
                    operation = await operationService.markTerminal(
                        operation.operationId,
                        {
                            ...classified,
                            resultCode: classified.errorCode,
                            resultMessage: classified.errorMessage
                        }
                    );
                } catch (persistError) {
                    outcome = withOperation(
                        block(
                            ROLLBACK_CODE.RESULT_PERSISTENCE_UNKNOWN,
                            persistError.message ||
                                'Rollback Salesforce execution completed with an unknown persistable result.',
                            { snapshotId, generatedWorkspace }
                        ),
                        {
                            ...operation,
                            status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                        }
                    );
                    outcome.historyId = await recordHistory(
                        args,
                        snapshot,
                        outcome,
                        operation
                    );
                    return outcome;
                }

                const code =
                    classified.status ===
                    ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                        ? ROLLBACK_CODE.RESULT_UNKNOWN
                        : ROLLBACK_CODE.EXECUTION_FAILED;

                outcome = withOperation(
                    block(code, classified.errorMessage, {
                        snapshotId,
                        drift,
                        checkOnlyDeployment,
                        generatedWorkspace
                    }),
                    operation
                );
                outcome.historyId = await recordHistory(
                    args,
                    snapshot,
                    outcome,
                    operation
                );
                return outcome;
            }

            const classified =
                operationService.classifyExecutionResult(deploymentExecution);
            const salesforceDeploymentId =
                extractSalesforceDeploymentId(deploymentExecution);

            try {
                operation = await operationService.markTerminal(
                    operation.operationId,
                    {
                        status: classified.status,
                        salesforceDeploymentId,
                        salesforceStatus: deploymentExecution?.status || null,
                        resultCode:
                            classified.status ===
                            ROLLBACK_OPERATION_STATUS.SUCCEEDED
                                ? 'ROLLBACK_SUCCEEDED'
                                : classified.status ===
                                    ROLLBACK_OPERATION_STATUS.FAILED
                                  ? ROLLBACK_CODE.EXECUTION_FAILED
                                  : ROLLBACK_CODE.RESULT_UNKNOWN,
                        resultMessage: deploymentExecution?.message || null,
                        errorCode:
                            classified.status ===
                            ROLLBACK_OPERATION_STATUS.FAILED
                                ? ROLLBACK_CODE.EXECUTION_FAILED
                                : classified.status ===
                                    ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                                  ? ROLLBACK_CODE.RESULT_UNKNOWN
                                  : null,
                        errorMessage:
                            classified.status ===
                            ROLLBACK_OPERATION_STATUS.SUCCEEDED
                                ? null
                                : deploymentExecution?.message || null,
                        checkOnlyStatus: CHECK_ONLY_STATUS.SUCCESS
                    }
                );
            } catch (persistError) {
                outcome = withOperation(
                    block(
                        ROLLBACK_CODE.RESULT_PERSISTENCE_UNKNOWN,
                        persistError.message ||
                            'Rollback Salesforce result could not be persisted.',
                        {
                            snapshotId,
                            drift,
                            checkOnlyDeployment,
                            deploymentExecution,
                            generatedWorkspace
                        }
                    ),
                    {
                        ...operation,
                        status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT,
                        salesforceDeploymentId
                    }
                );
                outcome.historyId = await recordHistory(
                    args,
                    snapshot,
                    outcome,
                    operation
                );
                return outcome;
            }

            if (classified.status === ROLLBACK_OPERATION_STATUS.SUCCEEDED) {
                outcome = withOperation(
                    successResult({
                        snapshotId,
                        drift,
                        checkOnlyDeployment,
                        deploymentExecution,
                        generatedWorkspace
                    }),
                    operation
                );
                outcome.historyId = await recordHistory(
                    args,
                    snapshot,
                    outcome,
                    operation
                );
                return outcome;
            }

            const failCode =
                classified.status === ROLLBACK_OPERATION_STATUS.FAILED
                    ? ROLLBACK_CODE.EXECUTION_FAILED
                    : ROLLBACK_CODE.RESULT_UNKNOWN;

            outcome = withOperation(
                block(
                    failCode,
                    deploymentExecution?.message ||
                        'Rollback Salesforce deployment result is not definitive success.',
                    {
                        snapshotId,
                        drift,
                        checkOnlyDeployment,
                        deploymentExecution,
                        generatedWorkspace
                    }
                ),
                operation
            );
            outcome.historyId = await recordHistory(
                args,
                snapshot,
                outcome,
                operation
            );
            return outcome;
        } catch (error) {
            if (error instanceof OrgLockBusyError) {
                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.LOCK_BUSY,
                    errorMessage: error.message
                });
                return withOperation(
                    block(ROLLBACK_CODE.LOCK_BUSY, error.message, {
                        snapshotId,
                        lockBusy: true
                    }),
                    operation
                );
            }

            if (error instanceof OrgLockStoreUnavailableError) {
                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.LOCK_UNAVAILABLE,
                    errorMessage: error.message
                });
                return withOperation(
                    block(ROLLBACK_CODE.LOCK_UNAVAILABLE, error.message, {
                        snapshotId
                    }),
                    operation
                );
            }

            if (
                error instanceof OrgLockFenceError ||
                error instanceof OrgLockOwnershipError
            ) {
                operation = await persistFailed(operation, {
                    errorCode: ROLLBACK_CODE.LOCK_FENCE,
                    errorMessage: error.message
                });
                return withOperation(
                    block(ROLLBACK_CODE.LOCK_FENCE, error.message, {
                        snapshotId
                    }),
                    operation
                );
            }

            if (error instanceof RollbackBlockedError) {
                operation = await persistFailed(operation, {
                    errorCode: error.code,
                    errorMessage: error.message
                });
                const blocked = withOperation(
                    block(error.code, error.message, {
                        snapshotId,
                        generatedWorkspace
                    }),
                    operation
                );
                blocked.historyId = await recordHistory(
                    args,
                    snapshot,
                    blocked,
                    operation
                );
                return blocked;
            }

            if (executionStarted) {
                try {
                    operation = await operationService.markTerminal(
                        operation.operationId,
                        {
                            status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT,
                            errorCode: ROLLBACK_CODE.RESULT_UNKNOWN,
                            errorMessage: error.message
                        }
                    );
                } catch (persistError) {
                    void persistError;
                }

                const unknown = withOperation(
                    block(
                        ROLLBACK_CODE.RESULT_UNKNOWN,
                        error.message ||
                            'Salesforce rollback execution outcome cannot be determined.',
                        { snapshotId, generatedWorkspace }
                    ),
                    operation || {
                        status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                    }
                );
                unknown.historyId = await recordHistory(
                    args,
                    snapshot,
                    unknown,
                    operation
                );
                return unknown;
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

                    if (operation?.operationId) {
                        try {
                            await resolveOperationStore().updateOperation(
                                operation.operationId,
                                {
                                    lockReleasedAt: new Date().toISOString(),
                                    updatedAt: new Date().toISOString()
                                }
                            );
                        } catch (error) {
                            void error;
                        }
                    }
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
        runRollback,
        reconcileUnknownOperation: (input) =>
            operationService.reconcileUnknownOperation(input)
    };
}

const defaultRestore = createDestinationSnapshotRestoreService();

module.exports = {
    createDestinationSnapshotRestoreService,
    runRollback: defaultRestore.runRollback
};
