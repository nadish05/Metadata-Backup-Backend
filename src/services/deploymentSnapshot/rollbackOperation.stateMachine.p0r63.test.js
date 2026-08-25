'use strict';

const assert = require('assert');

const {
    RollbackOperationStateError
} = require('./rollbackOperation.errors');
const {
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const {
    createRollbackOperationService,
    evaluateExistingOperation,
    classifyExecutionResult,
    classifyExecutionException
} = require('./rollbackOperation.service');
const {
    ROLLBACK_OPERATION_STATUS
} = require('./rollbackOperation.types');

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

function service() {
    const store = createMemoryRollbackOperationStore();
    return createRollbackOperationService({
        getStore: () => store
    });
}

(async () => {
    await runTest('NOT_STARTED can move to IN_PROGRESS then terminal states', async () => {
        const ops = service();
        const created = await ops.createOperation({
            snapshotId: 'snap-1',
            destinationOrgId: '00D1'
        });
        assert.strictEqual(created.status, ROLLBACK_OPERATION_STATUS.NOT_STARTED);

        const started = await ops.transitionToInProgress(created.operationId);
        assert.strictEqual(started.status, ROLLBACK_OPERATION_STATUS.IN_PROGRESS);

        const succeeded = await ops.markTerminal(created.operationId, {
            status: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
            salesforceDeploymentId: '0AfSUCCESS'
        });
        assert.strictEqual(succeeded.status, ROLLBACK_OPERATION_STATUS.SUCCEEDED);
        assert.strictEqual(succeeded.success, true);
    });

    await runTest('invalid transitions are rejected', async () => {
        const ops = service();
        const created = await ops.createOperation({
            snapshotId: 'snap-2',
            destinationOrgId: '00D1'
        });
        await ops.transitionToInProgress(created.operationId);
        await ops.markTerminal(created.operationId, {
            status: ROLLBACK_OPERATION_STATUS.SUCCEEDED
        });

        await assert.rejects(
            () => ops.transitionToInProgress(created.operationId),
            RollbackOperationStateError
        );
        await assert.rejects(
            () =>
                ops.markTerminal(created.operationId, {
                    status: ROLLBACK_OPERATION_STATUS.FAILED
                }),
            RollbackOperationStateError
        );
    });

    await runTest('FAILED retry evaluation vs UNKNOWN and SUCCEEDED blocking', () => {
        assert.strictEqual(evaluateExistingOperation(null).action, 'CREATE');
        assert.strictEqual(
            evaluateExistingOperation({
                status: ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
                destinationOrgId: '00D1',
                snapshotId: 'snap-eval'
            }).action,
            'BLOCK_IN_PROGRESS'
        );
        assert.strictEqual(
            evaluateExistingOperation({
                status: ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                destinationOrgId: '00D1',
                snapshotId: 'snap-eval'
            }).action,
            'BLOCK_COMPLETED'
        );
        assert.strictEqual(
            evaluateExistingOperation({
                status: ROLLBACK_OPERATION_STATUS.FAILED,
                destinationOrgId: '00D1',
                snapshotId: 'snap-eval'
            }).action,
            'RETRY'
        );
        assert.strictEqual(
            evaluateExistingOperation({
                status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT,
                destinationOrgId: '00D1',
                snapshotId: 'snap-eval'
            }).action,
            'BLOCK_UNKNOWN'
        );
    });

    await runTest('execution classification does not treat uncertain results as FAILED', () => {
        assert.strictEqual(
            classifyExecutionResult({
                success: true,
                status: 'Succeeded',
                componentFailures: []
            }).status,
            ROLLBACK_OPERATION_STATUS.SUCCEEDED
        );
        assert.strictEqual(
            classifyExecutionResult({
                success: false,
                status: 'Failed'
            }).status,
            ROLLBACK_OPERATION_STATUS.FAILED
        );
        assert.strictEqual(
            classifyExecutionResult({ success: true, status: 'InProgress' }).status,
            ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        );
        assert.strictEqual(
            classifyExecutionException(new Error('timeout'), true).status,
            ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        );
        assert.strictEqual(
            classifyExecutionException(new Error('never sent'), false).status,
            ROLLBACK_OPERATION_STATUS.FAILED
        );
    });

    await runTest('FAILED retry creates a new operationId', async () => {
        const store = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({ getStore: () => store });
        const first = await ops.createOperation({
            snapshotId: 'snap-3',
            destinationOrgId: '00D1'
        });
        await ops.transitionToInProgress(first.operationId);
        await ops.markTerminal(first.operationId, {
            status: ROLLBACK_OPERATION_STATUS.FAILED
        });

        const retry = await ops.createOperation({
            snapshotId: 'snap-3',
            destinationOrgId: '00D1',
            retryOfOperationId: first.operationId
        });

        assert.notStrictEqual(retry.operationId, first.operationId);
        assert.strictEqual(retry.retryOfOperationId, first.operationId);
        const original = await store.getOperation(first.operationId);
        assert.strictEqual(original.status, ROLLBACK_OPERATION_STATUS.FAILED);
    });

    await runTest('crash recovery distinguishes before vs during Salesforce execution', async () => {
        const ops = service();
        const before = await ops.createOperation({
            snapshotId: 'snap-4',
            destinationOrgId: '00D1'
        });
        await ops.transitionToInProgress(before.operationId);
        const startedBefore = await ops.findLatestForSnapshot('00D1', 'snap-4');
        const recoveredBefore = await ops.recoverAbandonedInProgress(startedBefore);
        assert.strictEqual(
            recoveredBefore.status,
            ROLLBACK_OPERATION_STATUS.FAILED
        );

        const during = await ops.createOperation({
            snapshotId: 'snap-5',
            destinationOrgId: '00D1'
        });
        await ops.transitionToInProgress(during.operationId);
        await ops.markExecutionStarted(during.operationId);
        const recoveredDuring = await ops.recoverAbandonedInProgress(
            await ops.findLatestForSnapshot('00D1', 'snap-5')
        );
        assert.strictEqual(
            recoveredDuring.status,
            ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        );
    });

    await runTest('UNKNOWN_RESULT reconciliation requires authoritative status', async () => {
        const ops = service();
        const created = await ops.createOperation({
            snapshotId: 'snap-6',
            destinationOrgId: '00D1'
        });
        await ops.transitionToInProgress(created.operationId);
        await ops.markTerminal(created.operationId, {
            status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        });

        const unchanged = await ops.reconcileUnknownOperation({
            operationId: created.operationId,
            salesforceStatus: 'InProgress'
        });
        assert.strictEqual(
            unchanged.status,
            ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        );

        const succeeded = await ops.reconcileUnknownOperation({
            operationId: created.operationId,
            salesforceDeploymentId: '0AfREC',
            salesforceStatus: 'Succeeded',
            actor: 'operator',
            reason: 'verified in Salesforce'
        });
        assert.strictEqual(succeeded.status, ROLLBACK_OPERATION_STATUS.SUCCEEDED);
        assert.strictEqual(succeeded.reconciledBy, 'operator');
    });
})();
