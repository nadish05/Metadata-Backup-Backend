'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createDeploymentRollbackAsyncService,
    getDefaultRollbackOperationStore
} = require('./deploymentRollbackAsync.service');
const {
    createRollbackOperationService
} = require('./deploymentSnapshot/rollbackOperation.service');
const {
    ROLLBACK_OPERATION_STATUS
} = require('./deploymentSnapshot/rollbackOperation.types');
const {
    createMemoryRollbackOperationStore
} = require('./deploymentSnapshot/stores/memoryRollbackOperationStore');
const {
    createDeploymentRollbackService
} = require('./deploymentRollback.service');
const { ROLLBACK_CODE } = require('./deploymentSnapshot/snapshotRestore.errors');
const {
    getSharedRollbackOperationStore,
    resetSharedRollbackOperationStoreForTests
} = require('./deploymentSnapshot/rollbackOperation.resolver');
const {
    STORAGE_MODE_ENV,
    DURABLE_ROOT_ENV
} = require('./deploymentSnapshot/snapshotStorage.config');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(service, operationId, status) {
    const started = Date.now();

    while (Date.now() - started < 1000) {
        const response = await service.getRollbackStatus(operationId);
        if (response.found && response.body.status === status) {
            return response.body;
        }
        await delay(5);
    }

    throw new Error(`Timed out waiting for ${operationId} to become ${status}`);
}

async function waitForRelease() {
    const started = Date.now();

    while (!releaseExecution && Date.now() - started < 1000) {
        await delay(5);
    }
}

let releaseExecution;

function restoreEnv(previous) {
    Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    });
    resetSharedRollbackOperationStoreForTests();
}

async function main() {
    assert.strictEqual(
        getDefaultRollbackOperationStore(),
        getSharedRollbackOperationStore(),
        'default async store must be the shared rollback operation store'
    );

    const previousEnv = {
        [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
        [DURABLE_ROOT_ENV]: process.env[DURABLE_ROOT_ENV]
    };
    delete process.env[STORAGE_MODE_ENV];
    delete process.env[DURABLE_ROOT_ENV];
    resetSharedRollbackOperationStoreForTests();

    const unavailableStart = await createDeploymentRollbackAsyncService().startRollback(
        {
            historyId: 'history_unconfigured_store',
            refreshToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            snapshotId: 'snapshot_unconfigured',
            orgId: '00DUNCONFIGURED'
        }
    );
    assert.strictEqual(unavailableStart.httpStatus, 503);
    assert.strictEqual(
        unavailableStart.body.code,
        ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE
    );
    assert.match(
        unavailableStart.body.message,
        /Durable rollback operation storage is not configured/i
    );

    const durableRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'rollback-async-shared-store-')
    );
    process.env[STORAGE_MODE_ENV] = 'DURABLE';
    process.env[DURABLE_ROOT_ENV] = durableRoot;
    resetSharedRollbackOperationStoreForTests();

    const sharedStore = getSharedRollbackOperationStore();
    let injectedStoreResolver = null;
    const sharedDefaultService = createDeploymentRollbackAsyncService({
        executeRollback: async (args) => {
            injectedStoreResolver = args.rollbackOperationStore;
            return {
                body: {
                    success: true,
                    operationId: args.operationId,
                    operationStatus: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                    code: 'ROLLBACK_SUCCEEDED',
                    message: 'shared store rollback complete'
                }
            };
        }
    });
    const sharedStart = await sharedDefaultService.startRollback({
        historyId: 'history_shared_default',
        refreshToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        snapshotId: 'snapshot_shared_default',
        orgId: '00DSHARED'
    });
    assert.strictEqual(sharedStart.success, true);
    assert.strictEqual(
        sharedStart.status,
        ROLLBACK_OPERATION_STATUS.IN_PROGRESS
    );
    assert.strictEqual(injectedStoreResolver(), sharedStore);

    const sharedCompleted = await waitForStatus(
        sharedDefaultService,
        sharedStart.operationId,
        ROLLBACK_OPERATION_STATUS.SUCCEEDED
    );
    assert.strictEqual(
        sharedCompleted.operationId,
        sharedStart.operationId
    );
    assert.strictEqual(sharedCompleted.resultCode, 'ROLLBACK_SUCCEEDED');

    const persistedShared = await sharedStore.findByOperationId(
        sharedStart.operationId
    );
    assert.strictEqual(
        persistedShared.status,
        ROLLBACK_OPERATION_STATUS.SUCCEEDED
    );
    assert.strictEqual(persistedShared.destinationOrgId, '00DSHARED');
    assert.strictEqual(persistedShared.snapshotId, 'snapshot_shared_default');
    assert.ok(persistedShared.completedAt);
    assert.strictEqual(persistedShared.resultCode, 'ROLLBACK_SUCCEEDED');
    assert.strictEqual(
        persistedShared.resultMessage,
        'shared store rollback complete'
    );

    restoreEnv(previousEnv);

    const store = createMemoryRollbackOperationStore();
    const operationService = createRollbackOperationService({
        getStore: () => store
    });
    let executions = 0;

    const service = createDeploymentRollbackAsyncService({
        getStore: () => store,
        rollbackOperationService: operationService,
        executeRollback: async (args) => {
            executions += 1;
            const claimed = await operationService.claimOperation({
                operationId: args.operationId,
                destinationOrgId: args.orgId,
                snapshotId: args.snapshotId
            });
            await new Promise((resolve, reject) => {
                releaseExecution = resolve;
            });
            await operationService.markTerminal(args.operationId, {
                status: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                resultCode: 'ROLLBACK_SUCCEEDED',
                resultMessage: 'done'
            });
            return {
                body: {
                    success: true,
                    operationId: claimed.operation.operationId,
                    operationStatus: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                    deploymentExecution: { status: 'Succeeded' }
                }
            };
        }
    });

    const started = await service.startRollback({
        historyId: 'history_async',
        refreshToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        snapshotId: 'snapshot_async',
        orgId: '00DASYNC'
    });
    assert.strictEqual(started.success, true);
    assert.strictEqual(started.accepted, true);
    assert.strictEqual(started.status, ROLLBACK_OPERATION_STATUS.IN_PROGRESS);

    const duplicate = await service.startRollback({
        historyId: 'history_async',
        refreshToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        snapshotId: 'snapshot_async',
        orgId: '00DASYNC'
    });
    assert.strictEqual(duplicate.operationId, started.operationId);

    const running = await service.getRollbackStatus(started.operationId);
    assert.strictEqual(running.found, true);
    assert.strictEqual(running.body.status, ROLLBACK_OPERATION_STATUS.IN_PROGRESS);

    await waitForRelease();
    releaseExecution();
    const completed = await waitForStatus(
        service,
        started.operationId,
        ROLLBACK_OPERATION_STATUS.SUCCEEDED
    );
    assert.deepStrictEqual(completed.result, {
        success: true,
        operationId: started.operationId,
        operationStatus: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
        deploymentExecution: { status: 'Succeeded' }
    });
    assert.strictEqual(executions, 1);

    const persisted = await store.findByOperationId(started.operationId);
    assert.deepStrictEqual(persisted.finalResult, completed.result);

    let failedOperationId;
    const failingService = createDeploymentRollbackAsyncService({
        getStore: () => store,
        rollbackOperationService: operationService,
        executeRollback: async (args) => {
            failedOperationId = args.operationId;
            await operationService.claimOperation({
                operationId: args.operationId,
                destinationOrgId: args.orgId,
                snapshotId: args.snapshotId
            });
            throw new Error('background rollback failed');
        }
    });
    const failedStart = await failingService.startRollback({
        historyId: 'history_async_failure',
        refreshToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        snapshotId: 'snapshot_async_failure',
        orgId: '00DASYNC'
    });
    const failed = await waitForStatus(
        failingService,
        failedStart.operationId,
        ROLLBACK_OPERATION_STATUS.FAILED
    );
    assert.strictEqual(failedStart.operationId, failedOperationId);
    assert.strictEqual(failed.result.code, 'ROLLBACK_ASYNC_ERROR');
    assert.strictEqual(failed.result.message, 'background rollback failed');

    let realChainOperationId = null;
    let realChainArgs = null;
    const realChainStore = createMemoryRollbackOperationStore();
    const realChainOperationService = createRollbackOperationService({
        getStore: () => realChainStore
    });
    const rollbackService = createDeploymentRollbackService({
        historyService: {
            getHistory() {
                return {
                    snapshotId: 'snapshot_real_chain',
                    destinationOrgId: '00DREAL'
                };
            }
        },
        createRestoreService: () => ({
            async runRollback(args) {
                realChainArgs = args;
                const claimed = await realChainOperationService.claimOperation({
                    operationId: args.operationId,
                    destinationOrgId: args.destinationOrgId,
                    snapshotId: args.snapshotId
                });
                realChainOperationId = claimed.operation.operationId;
                await realChainOperationService.markTerminal(
                    args.operationId,
                    {
                        status: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                        resultCode: 'ROLLBACK_SUCCEEDED',
                        resultMessage: 'real chain complete'
                    }
                );
                return {
                    success: true,
                    operationId: args.operationId,
                    operationStatus: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                    deploymentExecution: {
                        status: 'Succeeded',
                        deploymentId: '0AfREAL'
                    }
                };
            }
        })
    });
    const realChainService = createDeploymentRollbackAsyncService({
        getStore: () => realChainStore,
        rollbackOperationService: realChainOperationService,
        executeRollback: rollbackService.executeRollback
    });
    const realChainStart = await realChainService.startRollback({
        historyId: 'history_real_chain',
        refreshToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        snapshotId: 'snapshot_real_chain',
        orgId: '00DREAL'
    });
    assert.strictEqual(realChainStart.success, true);
    assert.strictEqual(realChainStart.status, ROLLBACK_OPERATION_STATUS.IN_PROGRESS);
    const realChainResult = await waitForStatus(
        realChainService,
        realChainStart.operationId,
        ROLLBACK_OPERATION_STATUS.SUCCEEDED
    );
    assert.strictEqual(realChainOperationId, realChainStart.operationId);
    assert.strictEqual(realChainArgs.operationId, realChainStart.operationId);
    assert.strictEqual(
        realChainResult.result.deploymentExecution.deploymentId,
        '0AfREAL'
    );
    assert.strictEqual(
        (
            await realChainStore.findByDestinationAndSnapshot(
                '00DREAL',
                'snapshot_real_chain'
            )
        ).length,
        1
    );

    const syncArgs = [];
    const syncService = createDeploymentRollbackService({
        historyService: {
            getHistory() {
                return { snapshotId: 'snapshot_sync' };
            }
        },
        restoreService: {
            async runRollback(args) {
                syncArgs.push(args);
                return {
                    success: true,
                    operationId: 'rbo-sync',
                    operationStatus: ROLLBACK_OPERATION_STATUS.SUCCEEDED
                };
            }
        }
    });
    await syncService.executeRollback({
        historyId: 'history_sync',
        snapshotId: 'snapshot_sync',
        refreshToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        orgId: '00DSYNC'
    });
    assert.strictEqual(syncArgs[0].operationId, undefined);
    assert.strictEqual(syncArgs[0].rollbackOperationStore, undefined);

    try {
        fs.rmSync(durableRoot, { recursive: true, force: true });
    } catch (error) {
        void error;
    }
}

main()
    .then(() => console.log('deploymentRollbackAsync.service.test.js PASSED'))
    .catch((error) => {
        console.error('deploymentRollbackAsync.service.test.js FAILED');
        console.error(error);
        process.exitCode = 1;
    });
