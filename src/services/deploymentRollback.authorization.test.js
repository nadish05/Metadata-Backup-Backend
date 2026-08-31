'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS
} = require('./deploymentSnapshot/snapshot.types');
const { packMemberFiles } = require('./deploymentSnapshot/destinationMemberArtifact.service');
const { hashBytes } = require('./deploymentSnapshot/snapshotIntegrity.service');
const {
    createSnapshotCaptureService
} = require('./deploymentSnapshot/snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./deploymentSnapshot/stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./deploymentSnapshot/stores/memorySnapshotBlobStore');
const {
    createDestinationSnapshotRestoreService
} = require('./deploymentSnapshot/destinationSnapshotRestore.service');
const { ROLLBACK_CODE } = require('./deploymentSnapshot/snapshotRestore.errors');
const {
    ROLLBACK_AUTHORIZATION_ACTION,
    ROLLBACK_AUTHORIZATION_DECISION
} = require('./deploymentSnapshot/rollbackAuthorization.types');
const {
    getSharedRollbackAuthorizationService
} = require('./deploymentSnapshot/rollbackAuthorization.service');
const {
    createTestTrustedActor
} = require('./deploymentSnapshot/rollbackAuthorization.testProvider');
const {
    TRUSTED_ACTOR_SOURCE
} = require('./deploymentSnapshot/rollbackActor.context');
const {
    createHttpRollbackAuthorizationProvider,
    createHttpRollbackTrustedActorResolver,
    createRollbackHttpAuthorizationDependencies,
    HTTP_ROLLBACK_ACTOR_ID,
    resetHttpRollbackAuthorizationServiceForTests
} = require('./deploymentSnapshot/rollbackAuthorization.httpProvider');
const {
    createMemoryOrgLockStore
} = require('./deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createOrgLockService
} = require('./deploymentOrgLock/deploymentOrgLock.service');
const {
    createMemoryRollbackOperationStore
} = require('./deploymentSnapshot/stores/memoryRollbackOperationStore');

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
            bytes: Buffer.from(
                'public class AccountService {\n    // before\n}\n',
                'utf8'
            )
        }
    ]);
}

function afterBytes() {
    return packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/AccountService.cls',
            bytes: Buffer.from(
                'public class AccountService {\n    // after\n}\n',
                'utf8'
            )
        }
    ]);
}

async function sealEligibleModified() {
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

const DEST = '00D000000000001';

(async () => {
    await runTest(
        'global getSharedRollbackAuthorizationService remains unavailable',
        async () => {
            const shared = getSharedRollbackAuthorizationService();
            const decision = await shared.authorize({
                actor: createTestTrustedActor({
                    source: TRUSTED_ACTOR_SOURCE.FUTURE_AUTH_ADAPTER
                }),
                action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
                destinationOrgId: DEST
            });

            assert.strictEqual(
                decision.decision,
                ROLLBACK_AUTHORIZATION_DECISION.UNAVAILABLE
            );
            assert.strictEqual(decision.reasonCode, 'AUTHORIZATION_UNAVAILABLE');
        }
    );

    await runTest('HTTP rollback provider authorizes ROLLBACK trusted actor', async () => {
        resetHttpRollbackAuthorizationServiceForTests();
        const provider = createHttpRollbackAuthorizationProvider();
        const actor = createHttpRollbackTrustedActorResolver();

        const decision = await provider.authorize({
            actor,
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: DEST,
            snapshotId: 'snap-1'
        });

        assert.strictEqual(
            decision.decision,
            ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED
        );
        assert.strictEqual(decision.reasonCode, 'AUTHORIZED');
        assert.strictEqual(decision.actorId, HTTP_ROLLBACK_ACTOR_ID);
        assert.strictEqual(
            decision.actorTrustLevel,
            'TRUSTED_ACTOR'
        );
    });

    await runTest(
        'HTTP rollback provider denies recover/reconcile actions',
        async () => {
            const provider = createHttpRollbackAuthorizationProvider();
            const actor = createHttpRollbackTrustedActorResolver();

            const recover = await provider.authorize({
                actor,
                action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER,
                destinationOrgId: DEST
            });
            assert.strictEqual(recover.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
            assert.strictEqual(recover.reasonCode, 'ACTION_DENIED');
        }
    );

    await runTest(
        'deploymentRollback service merges HTTP authorization dependencies',
        () => {
            const deps = createRollbackHttpAuthorizationDependencies();

            assert.strictEqual(typeof deps.resolveTrustedActor, 'function');
            assert.strictEqual(
                typeof deps.getRollbackAuthorizationService,
                'function'
            );

            const actor = deps.resolveTrustedActor();
            assert.strictEqual(actor.trustLevel, 'TRUSTED_ACTOR');
            assert.strictEqual(
                actor.source,
                TRUSTED_ACTOR_SOURCE.FUTURE_AUTH_ADAPTER
            );
            assert.strictEqual(actor.actorId, HTTP_ROLLBACK_ACTOR_ID);
        }
    );

    await runTest(
        'HTTP authorization dependencies pass restore authorization gate',
        async () => {
            resetHttpRollbackAuthorizationServiceForTests();
            const { capture, sealed } = await sealEligibleModified();

            const restore = createDestinationSnapshotRestoreService({
                captureService: capture,
                getRollbackOperationStore: () =>
                    createMemoryRollbackOperationStore(),
                isSnapshotRollbackEnabled: () => true,
                isDurableSnapshotStorageReady: () => true,
                isDeploymentOrgLockEnabled: () => true,
                getOrgLockService: () =>
                    createOrgLockService({
                        store: createMemoryOrgLockStore()
                    }),
                createOwnerId: () => 'rollback-owner',
                resolveVerifiedDestinationOrgId: async () => DEST,
                startLockHeartbeat: () => () => {},
                retrieveDestinationMember: async () => ({
                    artifactBytes: afterBytes(),
                    files: []
                }),
                runCheckOnlyDeployment: async () => ({
                    executed: true,
                    success: true,
                    status: 'Succeeded',
                    message: 'ok'
                }),
                runDeploymentExecution: async () => ({
                    success: true,
                    status: 'Succeeded',
                    message: 'deployed'
                }),
                ...createRollbackHttpAuthorizationDependencies()
            });

            const result = await restore.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                destinationOrgId: DEST,
                historyId: 'hist-http-auth'
            });

            assert.notStrictEqual(
                result.code,
                ROLLBACK_CODE.AUTHORIZATION_DENIED
            );
            assert.notStrictEqual(
                result.code,
                ROLLBACK_CODE.AUTHORIZATION_UNAVAILABLE
            );
        }
    );

    await runTest(
        'restore without HTTP authorization dependencies remains denied',
        async () => {
            const { capture, sealed } = await sealEligibleModified();
            let executions = 0;

            const restore = createDestinationSnapshotRestoreService({
                captureService: capture,
                getRollbackOperationStore: () =>
                    createMemoryRollbackOperationStore(),
                isSnapshotRollbackEnabled: () => true,
                isDurableSnapshotStorageReady: () => true,
                isDeploymentOrgLockEnabled: () => true,
                getOrgLockService: () =>
                    createOrgLockService({
                        store: createMemoryOrgLockStore()
                    }),
                resolveVerifiedDestinationOrgId: async () => DEST,
                runDeploymentExecution: async () => {
                    executions += 1;
                    return { success: true };
                }
            });

            const result = await restore.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                destinationOrgId: DEST
            });

            assert.strictEqual(result.blocked, true);
            assert.strictEqual(
                result.code,
                ROLLBACK_CODE.AUTHORIZATION_DENIED
            );
            assert.strictEqual(executions, 0);
        }
    );
})();
