'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertSafeStorageKey } = require('../../utils/durableFileStore');
const {
    historyRecordContainsSecrets
} = require('../deploymentHistory.sanitize');
const {
    RollbackOperationPersistenceError,
    RollbackOperationSchemaError,
    RollbackOperationStateError
} = require('./rollbackOperation.errors');
const {
    createFileRollbackOperationStore
} = require('./stores/fileRollbackOperationStore');
const {
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const {
    createUnavailableRollbackOperationStore
} = require('./stores/unavailableRollbackOperationStore');
const { assertRollbackOperationStore } = require('./stores/rollbackOperationStore');
const {
    createRollbackOperationService
} = require('./rollbackOperation.service');
const {
    ROLLBACK_OPERATION_STATUS,
    ROLLBACK_OPERATION_SCHEMA_VERSION
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

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'p0r63-ops-'));
}

(async () => {
    await runTest('memory and file stores implement the contract', () => {
        assertRollbackOperationStore(createMemoryRollbackOperationStore());
        assertRollbackOperationStore(
            createFileRollbackOperationStore({ rootDir: tempRoot() })
        );
    });

    await runTest('unavailable store is fail-closed', async () => {
        const store = createUnavailableRollbackOperationStore('no root');
        await assert.rejects(
            () => store.createOperation({ operationId: 'x' }),
            RollbackOperationPersistenceError
        );
    });

    await runTest('file store persists across process restart', async () => {
        const root = tempRoot();
        const first = createFileRollbackOperationStore({ rootDir: root });
        const ops = createRollbackOperationService({ getStore: () => first });
        const created = await ops.createOperation({
            snapshotId: 'snap-restart',
            destinationOrgId: '00Ddest'
        });
        await ops.transitionToInProgress(created.operationId);

        const restarted = createFileRollbackOperationStore({ rootDir: root });
        const loaded = await restarted.getOperation(created.operationId);
        assert.strictEqual(loaded.status, ROLLBACK_OPERATION_STATUS.IN_PROGRESS);
        assert.strictEqual(loaded.snapshotId, 'snap-restart');
        assert.ok(
            fs.existsSync(
                path.join(root, 'rollback-operations', `${created.operationId}.json`)
            )
        );
    });

    await runTest('path traversal is rejected', async () => {
        const store = createFileRollbackOperationStore({ rootDir: tempRoot() });
        await assert.rejects(
            () => store.getOperation('../escape'),
            TypeError
        );
        assert.throws(() => assertSafeStorageKey('../escape', 'operationId'));
    });

    await runTest('corrupt JSON is not silently treated as a valid operation', async () => {
        const root = tempRoot();
        const store = createFileRollbackOperationStore({ rootDir: root });
        const ops = createRollbackOperationService({ getStore: () => store });
        const created = await ops.createOperation({
            snapshotId: 'snap-corrupt',
            destinationOrgId: '00Ddest'
        });
        fs.writeFileSync(
            path.join(root, 'rollback-operations', `${created.operationId}.json`),
            '{not-json'
        );
        await assert.rejects(
            () => store.getOperation(created.operationId),
            RollbackOperationPersistenceError
        );
    });

    await runTest('unknown schemaVersion is rejected', async () => {
        const root = tempRoot();
        const store = createFileRollbackOperationStore({ rootDir: root });
        const ops = createRollbackOperationService({ getStore: () => store });
        const created = await ops.createOperation({
            snapshotId: 'snap-schema',
            destinationOrgId: '00Ddest'
        });
        const filePath = path.join(
            root,
            'rollback-operations',
            `${created.operationId}.json`
        );
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        parsed.schemaVersion = ROLLBACK_OPERATION_SCHEMA_VERSION + 99;
        fs.writeFileSync(filePath, JSON.stringify(parsed));
        await assert.rejects(
            () => store.getOperation(created.operationId),
            RollbackOperationSchemaError
        );
    });

    await runTest('terminal records cannot be overwritten without reconciliation', async () => {
        const store = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({ getStore: () => store });
        const created = await ops.createOperation({
            snapshotId: 'snap-term',
            destinationOrgId: '00Ddest'
        });
        await ops.transitionToInProgress(created.operationId);
        await ops.markTerminal(created.operationId, {
            status: ROLLBACK_OPERATION_STATUS.SUCCEEDED
        });
        await assert.rejects(
            () =>
                store.updateOperation(created.operationId, {
                    status: ROLLBACK_OPERATION_STATUS.FAILED
                }),
            RollbackOperationStateError
        );
    });

    await runTest('persisted operations are sanitized', async () => {
        const store = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({ getStore: () => store });
        const created = await ops.createOperation({
            snapshotId: 'snap-secret',
            destinationOrgId: '00Ddest',
            refreshToken: 'secret-token',
            accessToken: 'secret-access'
        });
        assert.strictEqual(created.refreshToken, undefined);
        assert.strictEqual(created.accessToken, undefined);
        assert.strictEqual(historyRecordContainsSecrets(created), false);
    });
})();
