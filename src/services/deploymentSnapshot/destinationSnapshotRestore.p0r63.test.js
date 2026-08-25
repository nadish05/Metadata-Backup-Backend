'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    createSnapshotCaptureService
} = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    createDestinationSnapshotRestoreService
} = require('./destinationSnapshotRestore.service');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    createMemoryOrgLockStore
} = require('../deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const { OPERATION_TYPE } = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    createDeploymentHistoryService
} = require('../deploymentHistory.service');
const {
    createMemoryDeploymentHistoryStore
} = require('../deploymentHistoryStores/memoryDeploymentHistoryStore');
const {
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const {
    createUnavailableRollbackOperationStore
} = require('./stores/unavailableRollbackOperationStore');
const {
    RollbackOperationPersistenceError
} = require('./rollbackOperation.errors');
const {
    ROLLBACK_OPERATION_STATUS
} = require('./rollbackOperation.types');
const {
    DURABLE_SNAPSHOT_STORAGE_CAPABILITY
} = require('./snapshotStorageCapability');
const { isSnapshotRollbackEnabled } = require('./snapshotRollback.flag');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function beforeBytes() {
    return packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/AccountService.cls',
            bytes: Buffer.from('public class AccountService {\n    // before\n}\n', 'utf8')
        }
    ]);
}

function afterBytes() {
    return packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/AccountService.cls',
            bytes: Buffer.from('public class AccountService {\n    // after\n}\n', 'utf8')
        }
    ]);
}

async function sealEligible() {
    const capture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: '00D000000000001',
            sourceOrgId: '00D000000000002'
        },
        members: [
            {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: 'force-app/main/default/classes/AccountService.cls',
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: beforeBytes(),
                expectedAfterHash: hashBytes(afterBytes())
            }
        ]
    });
    const sealed = await capture.sealSnapshot(ready.snapshotId);
    return { capture, sealed };
}

function createRestore({
    capture,
    lockService,
    operationStore = createMemoryRollbackOperationStore(),
    retrieveBytes = afterBytes(),
    checkOnlySuccess = true,
    executeSuccess = true,
    executeThrows = false,
    executeResult,
    historyService = null,
    holdRetrieve,
    updateOperationHook,
    releaseThrows = false,
    workspaceThrows = false
} = {}) {
    let executions = 0;
    const store = operationStore;
    const wrappedStore = updateOperationHook
        ? {
              ...store,
              updateOperation: async (id, patch, options) =>
                  updateOperationHook(store, id, patch, options)
          }
        : store;

    const orgLock = lockService || createOrgLockService({
        store: createMemoryOrgLockStore()
    });
    if (releaseThrows) {
        const originalRelease = orgLock.release.bind(orgLock);
        orgLock.release = (args) => {
            originalRelease(args);
            throw new Error('release failed');
        };
    }

    const service = createDestinationSnapshotRestoreService({
        captureService: capture,
        getRollbackOperationStore: () => wrappedStore,
        isSnapshotRollbackEnabled: () => true,
        isDurableSnapshotStorageReady: () => true,
        isDeploymentOrgLockEnabled: () => true,
        getOrgLockService: () => orgLock,
        createOwnerId: () => 'rollback-owner',
        resolveVerifiedDestinationOrgId: async () => '00D000000000001',
        startLockHeartbeat: () => () => {},
        retrieveDestinationMember: async () => {
            if (holdRetrieve) {
                await holdRetrieve();
            }
            return { artifactBytes: retrieveBytes, files: [] };
        },
        buildRestoreWorkspace: workspaceThrows
            ? async () => {
                  throw new Error('workspace boom');
              }
            : undefined,
        runCheckOnlyDeployment: async () => ({
            executed: true,
            success: checkOnlySuccess,
            status: checkOnlySuccess ? 'Succeeded' : 'Failed',
            message: checkOnlySuccess ? 'ok' : 'check-only failed'
        }),
        runDeploymentExecution: async () => {
            executions += 1;
            if (executeThrows) {
                throw new Error('cli timeout after request');
            }
            if (executeResult) {
                return executeResult;
            }
            return {
                success: executeSuccess,
                status: executeSuccess ? 'Succeeded' : 'Failed',
                message: executeSuccess ? 'deployed' : 'deploy failed',
                deploymentId: executeSuccess ? '0AfOK' : '0AfFAIL',
                componentFailures: []
            };
        },
        historyService
    });

    return { service, operationStore: wrappedStore, orgLock, counts: () => ({ executions }) };
}

(async () => {
    await runTest('validation failures do not create operations', async () => {
        const restore = createRestore({
            capture: createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            })
        });
        const result = await restore.service.runRollback({
            snapshotId: 'missing',
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.SNAPSHOT_NOT_FOUND);
        assert.strictEqual(
            (await restore.operationStore.findBySnapshotId('missing')).length,
            0
        );
    });

    await runTest('unavailable operation store fails closed before Salesforce', async () => {
        const { capture, sealed } = await sealEligible();
        const restore = createRestore({
            capture,
            operationStore: createUnavailableRollbackOperationStore('down')
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE);
        assert.strictEqual(restore.counts().executions, 0);
    });

    await runTest('IN_PROGRESS duplicate is blocked for the same destination+snapshot', async () => {
        const { capture, sealed } = await sealEligible();
        const operationStore = createMemoryRollbackOperationStore();
        let releaseWait;
        const waiting = new Promise((resolve) => {
            releaseWait = resolve;
        });
        const first = createRestore({
            capture,
            operationStore,
            holdRetrieve: () => waiting
        });
        const firstPromise = first.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        for (let i = 0; i < 50; i += 1) {
            const current = await operationStore.findByDestinationAndSnapshot(
                '00D000000000001',
                sealed.snapshotId
            );
            if (
                current.some(
                    (record) =>
                        record.status === ROLLBACK_OPERATION_STATUS.IN_PROGRESS
                )
            ) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const second = createRestore({ capture, operationStore });
        const blocked = await second.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(blocked.code, ROLLBACK_CODE.ALREADY_IN_PROGRESS);

        releaseWait();
        const completed = await firstPromise;
        assert.strictEqual(completed.blocked, false);
    });

    await runTest('SUCCEEDED duplicate is blocked and does not execute Salesforce again', async () => {
        const { capture, sealed } = await sealEligible();
        const operationStore = createMemoryRollbackOperationStore();
        const first = createRestore({ capture, operationStore });
        const ok = await first.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(ok.blocked, false);
        const snapshotBefore = await capture.getSnapshot(sealed.snapshotId);

        const second = createRestore({ capture, operationStore });
        const blocked = await second.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(blocked.code, ROLLBACK_CODE.ALREADY_COMPLETED);
        assert.strictEqual(second.counts().executions, 0);
        const snapshotAfter = await capture.getSnapshot(sealed.snapshotId);
        assert.strictEqual(snapshotAfter.status, snapshotBefore.status);
        assert.strictEqual(
            snapshotAfter.overallIntegrityHash,
            snapshotBefore.overallIntegrityHash
        );
    });

    await runTest('FAILED allows a new retry operation', async () => {
        const { capture, sealed } = await sealEligible();
        const operationStore = createMemoryRollbackOperationStore();
        const failed = createRestore({
            capture,
            operationStore,
            executeSuccess: false
        });
        const failResult = await failed.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(failResult.code, ROLLBACK_CODE.EXECUTION_FAILED);
        const firstId = failResult.operationId;

        const retry = createRestore({ capture, operationStore });
        const ok = await retry.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(ok.blocked, false);
        assert.notStrictEqual(ok.operationId, firstId);
        const original = await operationStore.getOperation(firstId);
        assert.strictEqual(original.status, ROLLBACK_OPERATION_STATUS.FAILED);
        const retryOp = await operationStore.getOperation(ok.operationId);
        assert.strictEqual(retryOp.retryOfOperationId, firstId);
    });

    await runTest('UNKNOWN_RESULT blocks automatic retry', async () => {
        const { capture, sealed } = await sealEligible();
        const operationStore = createMemoryRollbackOperationStore();
        const unknown = createRestore({
            capture,
            operationStore,
            executeThrows: true
        });
        const result = await unknown.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.RESULT_UNKNOWN);
        assert.strictEqual(
            result.operationStatus,
            ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        );

        const retry = createRestore({ capture, operationStore });
        const blocked = await retry.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(blocked.code, ROLLBACK_CODE.RESULT_UNKNOWN);
        assert.strictEqual(retry.counts().executions, 0);
    });

    await runTest('different destination orgs keep independent operations', async () => {
        const store = createMemoryRollbackOperationStore();
        await store.createOperation({
            operationId: 'op-a',
            snapshotId: 'snap-shared',
            destinationOrgId: '00DA',
            status: ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
            updatedAt: new Date().toISOString()
        });
        await store.createOperation({
            operationId: 'op-b',
            snapshotId: 'snap-shared',
            destinationOrgId: '00DB',
            status: ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
            updatedAt: new Date().toISOString()
        });
        const forA = await store.findByDestinationAndSnapshot('00DA', 'snap-shared');
        const forB = await store.findByDestinationAndSnapshot('00DB', 'snap-shared');
        assert.strictEqual(forA.length, 1);
        assert.strictEqual(forB.length, 1);
        assert.strictEqual(forA[0].operationId, 'op-a');
        assert.strictEqual(forB[0].operationId, 'op-b');
    });

    await runTest('explicit Salesforce SUCCESS and FAILED map to terminal states', async () => {
        const { capture, sealed } = await sealEligible();
        const ok = createRestore({
            capture,
            executeResult: {
                success: true,
                status: 'Succeeded',
                deploymentId: '0AfYES',
                componentFailures: []
            }
        });
        const okResult = await ok.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(okResult.blocked, false);
        const storedOk = await ok.operationStore.getOperation(okResult.operationId);
        assert.strictEqual(storedOk.status, ROLLBACK_OPERATION_STATUS.SUCCEEDED);
        assert.strictEqual(storedOk.salesforceDeploymentId, '0AfYES');

        const { capture: capture2, sealed: sealed2 } = await sealEligible();
        const failed = createRestore({
            capture: capture2,
            executeResult: {
                success: false,
                status: 'Failed',
                deploymentId: '0AfNO',
                message: 'component failed'
            }
        });
        const failResult = await failed.service.runRollback({
            snapshotId: sealed2.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(failResult.code, ROLLBACK_CODE.EXECUTION_FAILED);
        const storedFail = await failed.operationStore.getOperation(
            failResult.operationId
        );
        assert.strictEqual(storedFail.status, ROLLBACK_OPERATION_STATUS.FAILED);
    });

    await runTest('check-only failure and lock busy fail before Salesforce execution', async () => {
        const { capture, sealed } = await sealEligible();
        const check = createRestore({ capture, checkOnlySuccess: false });
        const checkResult = await check.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(checkResult.code, ROLLBACK_CODE.CHECK_ONLY_FAILED);
        assert.strictEqual(check.counts().executions, 0);
        const checkOp = await check.operationStore.getOperation(
            checkResult.operationId
        );
        assert.strictEqual(checkOp.status, ROLLBACK_OPERATION_STATUS.FAILED);
        assert.strictEqual(checkOp.checkOnlyStatus, 'FAILED');

        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        lockService.acquire({
            destinationOrgId: '00D000000000001',
            ownerId: 'deploy-owner',
            operationType: OPERATION_TYPE.DEPLOY
        });
        const { capture: capture2, sealed: sealed2 } = await sealEligible();
        const busy = createRestore({ capture: capture2, lockService });
        const busyResult = await busy.service.runRollback({
            snapshotId: sealed2.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(busyResult.code, ROLLBACK_CODE.LOCK_BUSY);
        const busyOp = await busy.operationStore.getOperation(
            busyResult.operationId
        );
        assert.strictEqual(busyOp.status, ROLLBACK_OPERATION_STATUS.FAILED);
        assert.strictEqual(busy.counts().executions, 0);
    });

    await runTest('workspace failure is FAILED; persistence failure after execution is UNKNOWN', async () => {
        const { capture, sealed } = await sealEligible();
        const workspace = createRestore({ capture, workspaceThrows: true });
        const workspaceResult = await workspace.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(workspaceResult.code, ROLLBACK_CODE.WORKSPACE_FAILED);
        assert.strictEqual(
            (await workspace.operationStore.getOperation(workspaceResult.operationId))
                .status,
            ROLLBACK_OPERATION_STATUS.FAILED
        );

        const { capture: capture2, sealed: sealed2 } = await sealEligible();
        const persistAfter = createRestore({
            capture: capture2,
            updateOperationHook: async (store, id, patch, options) => {
                if (patch.status === ROLLBACK_OPERATION_STATUS.SUCCEEDED) {
                    throw new RollbackOperationPersistenceError('cannot write success');
                }
                return store.updateOperation(id, patch, options);
            }
        });
        const persistResult = await persistAfter.service.runRollback({
            snapshotId: sealed2.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(
            persistResult.code,
            ROLLBACK_CODE.RESULT_PERSISTENCE_UNKNOWN
        );
        assert.notStrictEqual(
            persistResult.operationStatus,
            ROLLBACK_OPERATION_STATUS.FAILED
        );
    });

    await runTest('persistence failure before Salesforce execution fails closed', async () => {
        const { capture, sealed } = await sealEligible();
        const restore = createRestore({
            capture,
            updateOperationHook: async (store, id, patch, options) => {
                if (patch.executionStartedAt) {
                    throw new RollbackOperationPersistenceError('cannot mark start');
                }
                return store.updateOperation(id, patch, options);
            }
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE);
        assert.strictEqual(restore.counts().executions, 0);
    });

    await runTest('history persistence failure does not erase operation state', async () => {
        const { capture, sealed } = await sealEligible();
        const historyService = {
            createHistory() {
                throw new Error('history down');
            }
        };
        const restore = createRestore({ capture, historyService });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.blocked, false);
        assert.strictEqual(result.historyId, null);
        const operation = await restore.operationStore.getOperation(
            result.operationId
        );
        assert.strictEqual(operation.status, ROLLBACK_OPERATION_STATUS.SUCCEEDED);
    });

    await runTest('UNKNOWN_RESULT is recorded in history when history is available', async () => {
        const { capture, sealed } = await sealEligible();
        const historyService = createDeploymentHistoryService({
            store: createMemoryDeploymentHistoryStore()
        });
        const restore = createRestore({
            capture,
            historyService,
            executeThrows: true
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        const history = historyService.getHistory(result.historyId);
        assert.strictEqual(history.status, 'UNKNOWN_RESULT');
    });

    await runTest('lock release failure does not rewrite a successful operation as FAILED', async () => {
        const { capture, sealed } = await sealEligible();
        const restore = createRestore({ capture, releaseThrows: true });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.blocked, false);
        const operation = await restore.operationStore.getOperation(
            result.operationId
        );
        assert.strictEqual(operation.status, ROLLBACK_OPERATION_STATUS.SUCCEEDED);
    });

    await runTest('DEPLOY lock still serializes rollback and flags remain disabled', async () => {
        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        lockService.acquire({
            destinationOrgId: '00D000000000001',
            ownerId: 'deploy-owner',
            operationType: OPERATION_TYPE.DEPLOY
        });
        const { capture, sealed } = await sealEligible();
        const restore = createRestore({ capture, lockService });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.LOCK_BUSY);
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00D000000000001' }).ownerId,
            'deploy-owner'
        );
        assert.strictEqual(isSnapshotRollbackEnabled({}), false);
        assert.strictEqual(
            DURABLE_SNAPSHOT_STORAGE_CAPABILITY.rollbackProductionReady,
            false
        );
    });
})();
