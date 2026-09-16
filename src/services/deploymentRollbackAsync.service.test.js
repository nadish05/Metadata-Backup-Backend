'use strict';

const assert = require('assert');

const {
    createDeploymentRollbackAsyncService
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

async function main() {
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
}

main()
    .then(() => console.log('deploymentRollbackAsync.service.test.js PASSED'))
    .catch((error) => {
        console.error('deploymentRollbackAsync.service.test.js FAILED');
        console.error(error);
        process.exitCode = 1;
    });
