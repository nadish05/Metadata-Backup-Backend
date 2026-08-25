'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    RollbackOperationScopeAmbiguousError
} = require('./rollbackOperation.errors');
const {
    buildRollbackScopeKey,
    evaluateExistingOperations,
    rollbackScopeFileKey
} = require('./rollbackOperation.scope');
const {
    createRollbackOperationService
} = require('./rollbackOperation.service');
const {
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const {
    createFileRollbackOperationStore
} = require('./stores/fileRollbackOperationStore');
const { ROLLBACK_OPERATION_STATUS } = require('./rollbackOperation.types');
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
const {
    createMemoryOrgLockStore
} = require('../deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const {
    DURABLE_SNAPSHOT_STORAGE_CAPABILITY
} = require('./snapshotStorageCapability');
const { isSnapshotRollbackEnabled } = require('./snapshotRollback.flag');
const {
    LOCK_PRODUCTION_DISTRIBUTED_READY
} = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    createRollbackAuthorizationService
} = require('./rollbackAuthorization.service');
const {
    createTestRollbackAuthorizationProvider,
    createTestTrustedActor
} = require('./rollbackAuthorization.testProvider');

function allowRollbackAuthz() {
    return {
        getRollbackAuthorizationService: () =>
            createRollbackAuthorizationService({
                provider: createTestRollbackAuthorizationProvider({
                    rollback: true
                })
            }),
        resolveTrustedActor: () => createTestTrustedActor()
    };
}

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'p0r65-scope-'));
}

function afterBytes() {
    return packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/AccountService.cls',
            bytes: Buffer.from('public class AccountService {\n    // after\n}\n', 'utf8')
        }
    ]);
}

function beforeBytes() {
    return packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/AccountService.cls',
            bytes: Buffer.from('public class AccountService {\n    // before\n}\n', 'utf8')
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

    return {
        capture,
        sealed: await capture.sealSnapshot(ready.snapshotId)
    };
}

function op(status, extras = {}) {
    return {
        operationId: extras.operationId || `rbo-${status}-${Math.random()}`,
        destinationOrgId: extras.destinationOrgId || '00D1',
        snapshotId: extras.snapshotId || 'snap-1',
        status,
        createdAt: extras.createdAt || '2026-01-01T00:00:00.000Z',
        updatedAt: extras.updatedAt || '2026-01-02T00:00:00.000Z'
    };
}

(async () => {
    await runTest('SUCCEEDED is not hidden by a newer FAILED sibling', () => {
        const decision = evaluateExistingOperations([
            op(ROLLBACK_OPERATION_STATUS.SUCCEEDED, {
                operationId: 'rbo-success',
                updatedAt: '2026-01-01T00:00:00.000Z'
            }),
            op(ROLLBACK_OPERATION_STATUS.FAILED, {
                operationId: 'rbo-failed',
                updatedAt: '2026-01-03T00:00:00.000Z'
            })
        ]);

        assert.strictEqual(decision.action, 'BLOCK_COMPLETED');
        assert.strictEqual(decision.existing.operationId, 'rbo-success');
    });

    await runTest('UNKNOWN_RESULT is not hidden by a newer FAILED sibling', () => {
        const decision = evaluateExistingOperations([
            op(ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT, {
                operationId: 'rbo-unknown',
                updatedAt: '2026-01-01T00:00:00.000Z'
            }),
            op(ROLLBACK_OPERATION_STATUS.FAILED, {
                operationId: 'rbo-failed',
                updatedAt: '2026-01-09T00:00:00.000Z'
            })
        ]);

        assert.strictEqual(decision.action, 'BLOCK_UNKNOWN');
        assert.strictEqual(decision.existing.operationId, 'rbo-unknown');
    });

    await runTest('IN_PROGRESS is not hidden by a newer FAILED sibling', () => {
        const decision = evaluateExistingOperations([
            op(ROLLBACK_OPERATION_STATUS.IN_PROGRESS, {
                operationId: 'rbo-live',
                updatedAt: '2026-01-01T00:00:00.000Z'
            }),
            op(ROLLBACK_OPERATION_STATUS.FAILED, {
                operationId: 'rbo-failed',
                updatedAt: '2026-01-09T00:00:00.000Z'
            })
        ]);

        assert.strictEqual(decision.action, 'BLOCK_IN_PROGRESS');
        assert.strictEqual(decision.existing.operationId, 'rbo-live');
    });

    await runTest('only FAILED operations allow retry', () => {
        const decision = evaluateExistingOperations([
            op(ROLLBACK_OPERATION_STATUS.FAILED, {
                operationId: 'rbo-old',
                createdAt: '2026-01-01T00:00:00.000Z'
            }),
            op(ROLLBACK_OPERATION_STATUS.FAILED, {
                operationId: 'rbo-new',
                createdAt: '2026-01-02T00:00:00.000Z'
            })
        ]);

        assert.strictEqual(decision.action, 'RETRY');
        assert.strictEqual(decision.existing.operationId, 'rbo-new');
    });

    await runTest('invalid status fails closed', () => {
        assert.throws(
            () =>
                evaluateExistingOperations([
                    op('WEIRD', { operationId: 'rbo-bad' })
                ]),
            RollbackOperationScopeAmbiguousError
        );
    });

    await runTest('same-store concurrent claims produce one authoritative IN_PROGRESS', async () => {
        const store = createMemoryRollbackOperationStore();
        const left = createRollbackOperationService({ getStore: () => store });
        const right = createRollbackOperationService({ getStore: () => store });
        const input = {
            destinationOrgId: '00D1',
            snapshotId: 'snap-concurrent'
        };

        const [a, b] = await Promise.all([
            left.claimOperation(input),
            right.claimOperation(input)
        ]);
        const actions = [a.decision.action, b.decision.action].sort();
        assert.deepStrictEqual(actions, ['BLOCK_IN_PROGRESS', 'CREATE'].sort());
        assert.strictEqual(a.operation.operationId, b.operation.operationId);
        const records = await store.findByDestinationAndSnapshot(
            '00D1',
            'snap-concurrent'
        );
        assert.strictEqual(records.length, 1);
        assert.strictEqual(
            records[0].status,
            ROLLBACK_OPERATION_STATUS.IN_PROGRESS
        );
    });

    await runTest('restore treats SUCCEEDED+FAILED as already completed', async () => {
        const { capture, sealed } = await sealEligible();
        const operationStore = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({
            getStore: () => operationStore
        });
        const succeeded = await ops.createOperation({
            destinationOrgId: '00D000000000001',
            snapshotId: sealed.snapshotId
        });
        await ops.transitionToInProgress(succeeded.operationId);
        await ops.markTerminal(succeeded.operationId, {
            status: ROLLBACK_OPERATION_STATUS.SUCCEEDED
        });
        const failed = await ops.createOperation({
            destinationOrgId: '00D000000000001',
            snapshotId: sealed.snapshotId
        });
        await ops.transitionToInProgress(failed.operationId);
        await ops.markTerminal(failed.operationId, {
            status: ROLLBACK_OPERATION_STATUS.FAILED
        });

        const restore = createDestinationSnapshotRestoreService({
            captureService: capture,
            getRollbackOperationStore: () => operationStore,
            isSnapshotRollbackEnabled: () => true,
            isDurableSnapshotStorageReady: () => true,
            isDeploymentOrgLockEnabled: () => true,
            getOrgLockService: () =>
                createOrgLockService({ store: createMemoryOrgLockStore() }),
            createOwnerId: () => 'rollback-owner',
            ...allowRollbackAuthz(),
            resolveVerifiedDestinationOrgId: async () => '00D000000000001',
            startLockHeartbeat: () => () => {},
            retrieveDestinationMember: async () => ({
                artifactBytes: afterBytes(),
                files: []
            }),
            runCheckOnlyDeployment: async () => ({
                executed: true,
                success: true,
                status: 'Succeeded'
            }),
            runDeploymentExecution: async () => {
                throw new Error('must not execute');
            }
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.ALREADY_COMPLETED);
        assert.strictEqual(result.operationId, succeeded.operationId);
    });

    await runTest('restore treats UNKNOWN+FAILED as result unknown', async () => {
        const { capture, sealed } = await sealEligible();
        const operationStore = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({
            getStore: () => operationStore
        });
        const unknown = await ops.createOperation({
            destinationOrgId: '00D000000000001',
            snapshotId: sealed.snapshotId
        });
        await ops.transitionToInProgress(unknown.operationId);
        await ops.markTerminal(unknown.operationId, {
            status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        });
        const failed = await ops.createOperation({
            destinationOrgId: '00D000000000001',
            snapshotId: sealed.snapshotId
        });
        await ops.transitionToInProgress(failed.operationId);
        await ops.markTerminal(failed.operationId, {
            status: ROLLBACK_OPERATION_STATUS.FAILED
        });

        const restore = createDestinationSnapshotRestoreService({
            captureService: capture,
            getRollbackOperationStore: () => operationStore,
            isSnapshotRollbackEnabled: () => true,
            isDurableSnapshotStorageReady: () => true,
            isDeploymentOrgLockEnabled: () => true,
            getOrgLockService: () =>
                createOrgLockService({ store: createMemoryOrgLockStore() }),
            createOwnerId: () => 'rollback-owner',
            ...allowRollbackAuthz(),
            resolveVerifiedDestinationOrgId: async () => '00D000000000001',
            startLockHeartbeat: () => () => {},
            retrieveDestinationMember: async () => ({
                artifactBytes: afterBytes()
            }),
            runDeploymentExecution: async () => {
                throw new Error('must not execute');
            }
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.RESULT_UNKNOWN);
    });

    await runTest('restore treats IN_PROGRESS+FAILED as already in progress', async () => {
        const { capture, sealed } = await sealEligible();
        const operationStore = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({
            getStore: () => operationStore
        });
        const live = await ops.createOperation({
            destinationOrgId: '00D000000000001',
            snapshotId: sealed.snapshotId
        });
        await ops.transitionToInProgress(live.operationId);
        const failed = await ops.createOperation({
            destinationOrgId: '00D000000000001',
            snapshotId: sealed.snapshotId
        });
        await ops.transitionToInProgress(failed.operationId);
        await ops.markTerminal(failed.operationId, {
            status: ROLLBACK_OPERATION_STATUS.FAILED
        });

        const restore = createDestinationSnapshotRestoreService({
            captureService: capture,
            getRollbackOperationStore: () => operationStore,
            isSnapshotRollbackEnabled: () => true,
            isDurableSnapshotStorageReady: () => true,
            isDeploymentOrgLockEnabled: () => true,
            getOrgLockService: () =>
                createOrgLockService({ store: createMemoryOrgLockStore() }),
            createOwnerId: () => 'rollback-owner',
            ...allowRollbackAuthz(),
            resolveVerifiedDestinationOrgId: async () => '00D000000000001',
            startLockHeartbeat: () => () => {},
            runDeploymentExecution: async () => {
                throw new Error('must not execute');
            }
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.ALREADY_IN_PROGRESS);
        assert.strictEqual(result.operationId, live.operationId);
    });

    await runTest('FAILED-only retry still creates a new operationId', async () => {
        const store = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({ getStore: () => store });
        const first = await ops.claimOperation({
            destinationOrgId: '00D1',
            snapshotId: 'snap-retry'
        });
        await ops.markTerminal(first.operation.operationId, {
            status: ROLLBACK_OPERATION_STATUS.FAILED
        });
        const retry = await ops.claimOperation({
            destinationOrgId: '00D1',
            snapshotId: 'snap-retry'
        });
        assert.strictEqual(retry.decision.action, 'RETRY');
        assert.notStrictEqual(
            retry.operation.operationId,
            first.operation.operationId
        );
        assert.strictEqual(
            retry.operation.retryOfOperationId,
            first.operation.operationId
        );
        assert.strictEqual(
            (await store.getOperation(first.operation.operationId)).status,
            ROLLBACK_OPERATION_STATUS.FAILED
        );
    });

    await runTest('different destination orgs and snapshotIds have independent scopes', async () => {
        const store = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({ getStore: () => store });
        const a = await ops.claimOperation({
            destinationOrgId: '00DA',
            snapshotId: 'snap-shared'
        });
        const b = await ops.claimOperation({
            destinationOrgId: '00DB',
            snapshotId: 'snap-shared'
        });
        const c = await ops.claimOperation({
            destinationOrgId: '00DA',
            snapshotId: 'snap-other'
        });
        assert.notStrictEqual(a.operation.operationId, b.operation.operationId);
        assert.notStrictEqual(a.operation.operationId, c.operation.operationId);
        assert.strictEqual(
            a.operation.rollbackScopeKey,
            buildRollbackScopeKey('00DA', 'snap-shared')
        );
        assert.strictEqual(
            b.operation.rollbackScopeKey,
            buildRollbackScopeKey('00DB', 'snap-shared')
        );
    });

    await runTest('filesystem restart preserves scope and concurrent file stores fence first create', async () => {
        const root = tempRoot();
        const firstStore = createFileRollbackOperationStore({ rootDir: root });
        const firstOps = createRollbackOperationService({
            getStore: () => firstStore
        });
        const created = await firstOps.claimOperation({
            destinationOrgId: '00Ddest',
            snapshotId: 'snap-restart'
        });
        assert.strictEqual(
            created.operation.status,
            ROLLBACK_OPERATION_STATUS.IN_PROGRESS
        );

        const restarted = createFileRollbackOperationStore({ rootDir: root });
        const restartedOps = createRollbackOperationService({
            getStore: () => restarted
        });
        const again = await restartedOps.claimOperation({
            destinationOrgId: '00Ddest',
            snapshotId: 'snap-restart'
        });
        assert.strictEqual(again.decision.action, 'BLOCK_IN_PROGRESS');
        assert.strictEqual(
            again.operation.operationId,
            created.operation.operationId
        );

        const key = buildRollbackScopeKey('00Ddest', 'snap-restart');
        const scope = await restarted.getScope(key);
        assert.strictEqual(scope.activeOperationId, created.operation.operationId);
        assert.ok(
            fs.existsSync(
                path.join(
                    root,
                    'rollback-operation-scopes',
                    `${rollbackScopeFileKey(key)}.json`
                )
            )
        );

        const root2 = tempRoot();
        const left = createFileRollbackOperationStore({ rootDir: root2 });
        const right = createFileRollbackOperationStore({ rootDir: root2 });
        const leftOps = createRollbackOperationService({ getStore: () => left });
        const rightOps = createRollbackOperationService({
            getStore: () => right
        });
        const [one, two] = await Promise.all([
            leftOps.claimOperation({
                destinationOrgId: '00Dfile',
                snapshotId: 'snap-file'
            }),
            rightOps.claimOperation({
                destinationOrgId: '00Dfile',
                snapshotId: 'snap-file'
            })
        ]);
        const ids = new Set([
            one.operation.operationId,
            two.operation.operationId
        ]);
        assert.strictEqual(ids.size, 1);
        const listed = await left.findByDestinationAndSnapshot(
            '00Dfile',
            'snap-file'
        );
        assert.strictEqual(listed.length, 1);
    });

    await runTest('corrupt operation JSON fails closed instead of looking empty', async () => {
        const root = tempRoot();
        const store = createFileRollbackOperationStore({ rootDir: root });
        const ops = createRollbackOperationService({ getStore: () => store });
        const created = await ops.createOperation({
            destinationOrgId: '00Ddest',
            snapshotId: 'snap-corrupt'
        });
        fs.writeFileSync(
            path.join(root, 'rollback-operations', `${created.operationId}.json`),
            '{not-json'
        );
        await assert.rejects(
            () => store.findByDestinationAndSnapshot('00Ddest', 'snap-corrupt'),
            Error
        );
    });

    await runTest('corrupt scope JSON fails closed', async () => {
        const root = tempRoot();
        const store = createFileRollbackOperationStore({ rootDir: root });
        const key = buildRollbackScopeKey('00Ddest', 'snap-scope');
        const scopeDir = path.join(root, 'rollback-operation-scopes');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.writeFileSync(
            path.join(scopeDir, `${rollbackScopeFileKey(key)}.json`),
            '{bad'
        );
        await assert.rejects(() => store.getScope(key), Error);
        const ops = createRollbackOperationService({ getStore: () => store });
        await assert.rejects(
            () =>
                ops.claimOperation({
                    destinationOrgId: '00Ddest',
                    snapshotId: 'snap-scope'
                }),
            Error
        );
    });

    await runTest('legacy records without rollbackScopeKey still evaluate by dest and snapshot', () => {
        const decision = evaluateExistingOperations([
            {
                operationId: 'legacy-success',
                destinationOrgId: '00D1',
                snapshotId: 'snap-legacy',
                status: ROLLBACK_OPERATION_STATUS.SUCCEEDED
            },
            {
                operationId: 'legacy-failed',
                destinationOrgId: '00D1',
                snapshotId: 'snap-legacy',
                status: ROLLBACK_OPERATION_STATUS.FAILED,
                updatedAt: '2099-01-01T00:00:00.000Z'
            }
        ]);
        assert.strictEqual(decision.action, 'BLOCK_COMPLETED');
        assert.strictEqual(decision.existing.operationId, 'legacy-success');
    });

    await runTest('flags remain disabled', () => {
        assert.strictEqual(isSnapshotRollbackEnabled({}), false);
        assert.strictEqual(
            DURABLE_SNAPSHOT_STORAGE_CAPABILITY.rollbackProductionReady,
            false
        );
        assert.strictEqual(LOCK_PRODUCTION_DISTRIBUTED_READY, false);
    });
})();
