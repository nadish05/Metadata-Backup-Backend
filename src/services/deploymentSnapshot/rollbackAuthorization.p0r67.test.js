'use strict';

const assert = require('assert');

const {
    ACTOR_TRUST,
    ROLLBACK_AUTHORIZATION_ACTION,
    ROLLBACK_AUTHORIZATION_DECISION,
    SALESFORCE_DEPLOY_STATUS
} = require('./rollbackAuthorization.types');
const {
    createTrustedActorContext,
    resolveActorContext,
    TRUSTED_ACTOR_SOURCE
} = require('./rollbackActor.context');
const {
    createRollbackAuthorizationService,
    createUnavailableRollbackAuthorizationProvider,
    getSharedRollbackAuthorizationService
} = require('./rollbackAuthorization.service');
const {
    createTestRollbackAuthorizationProvider,
    createTestTrustedActor
} = require('./rollbackAuthorization.testProvider');
const {
    createRollbackRecoveryContract
} = require('./rollbackRecovery.contract');
const {
    createUnavailableSalesforceDeployStatusService,
    createTestSalesforceDeployStatusService,
    isAuthoritativeSalesforceEvidence
} = require('./salesforceDeployStatus.contract');
const {
    createAuthorizedLockRecovery
} = require('./authorizedLockRecovery.service');
const {
    createAuthorizedRollbackReconciliation
} = require('./authorizedRollbackReconciliation.service');
const {
    createRollbackOperationService
} = require('./rollbackOperation.service');
const {
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const { ROLLBACK_OPERATION_STATUS } = require('./rollbackOperation.types');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    createDestinationSnapshotRestoreService
} = require('./destinationSnapshotRestore.service');
const {
    createSnapshotCaptureService
} = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const { CHANGE_CLASS } = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    createMemoryOrgLockStore
} = require('../deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const { OPERATION_TYPE } = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    DURABLE_SNAPSHOT_STORAGE_CAPABILITY
} = require('./snapshotStorageCapability');
const { isSnapshotRollbackEnabled } = require('./snapshotRollback.flag');
const {
    LOCK_PRODUCTION_DISTRIBUTED_READY
} = require('../deploymentOrgLock/deploymentOrgLock.types');
const { buildRollbackAuditContext } = require('./rollbackAudit.context');

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
    const sealed = await capture.sealSnapshot(ready.snapshotId);
    return { capture, sealed };
}

function authzService(providerOptions) {
    return createRollbackAuthorizationService({
        provider: createTestRollbackAuthorizationProvider(providerOptions)
    });
}

(async () => {
    await runTest('no actor is denied', async () => {
        const decision = await authzService({ rollback: true }).authorize({
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
        assert.strictEqual(decision.reasonCode, 'NO_ACTOR');
    });

    await runTest('invalid actor is denied', async () => {
        const invalid = createTrustedActorContext({
            actorId: 'spoof',
            source: 'req.body'
        });
        assert.strictEqual(invalid.trustLevel, ACTOR_TRUST.INVALID_ACTOR_CONTEXT);
        const decision = await authzService({ rollback: true }).authorize({
            actor: invalid,
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
        assert.strictEqual(decision.reasonCode, 'INVALID_ACTOR');
    });

    await runTest('auth provider unavailable returns UNAVAILABLE', async () => {
        const decision = await createRollbackAuthorizationService({
            provider: createUnavailableRollbackAuthorizationProvider()
        }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(
            decision.decision,
            ROLLBACK_AUTHORIZATION_DECISION.UNAVAILABLE
        );
        assert.strictEqual(decision.reasonCode, 'AUTHORIZATION_UNAVAILABLE');
    });

    await runTest('authorized rollback is AUTHORIZED', async () => {
        const decision = await authzService({ rollback: true }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1',
            snapshotId: 'snap-1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED);
    });

    await runTest('unauthorized rollback is DENIED', async () => {
        const decision = await authzService({ rollback: false }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
    });

    await runTest('authorized recover is AUTHORIZED', async () => {
        const decision = await authzService({ recover: true }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER,
            destinationOrgId: '00D1',
            operationId: 'op-1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED);
    });

    await runTest('unauthorized recover is DENIED', async () => {
        const decision = await authzService({ rollback: true, recover: false }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
    });

    await runTest('authorized reconcile is AUTHORIZED', async () => {
        const decision = await authzService({ reconcile: true }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECONCILE,
            destinationOrgId: '00D1',
            operationId: 'op-1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED);
    });

    await runTest('unauthorized reconcile is DENIED', async () => {
        const decision = await authzService({ rollback: true }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECONCILE,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
    });

    await runTest('destination org is part of authorization context', async () => {
        const provider = createTestRollbackAuthorizationProvider({
            rollback: true,
            allowedDestinationOrgId: '00DALLOWED'
        });
        const service = createRollbackAuthorizationService({ provider });
        const denied = await service.authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00DOTHER',
            snapshotId: 'snap-1'
        });
        assert.strictEqual(denied.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
        assert.strictEqual(denied.reasonCode, 'DESTINATION_NOT_AUTHORIZED');
        const allowed = await service.authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00DALLOWED',
            snapshotId: 'snap-1'
        });
        assert.strictEqual(allowed.decision, ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED);
        assert.strictEqual(provider.lastRequest.current.destinationOrgId, '00DALLOWED');
    });

    await runTest('snapshot id is part of authorization context', async () => {
        const provider = createTestRollbackAuthorizationProvider({ rollback: true });
        await createRollbackAuthorizationService({ provider }).authorize({
            actor: createTestTrustedActor(),
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1',
            snapshotId: 'snap-bound'
        });
        assert.strictEqual(provider.lastRequest.current.snapshotId, 'snap-bound');
    });

    await runTest('operation id is part of recovery context', async () => {
        const provider = createTestRollbackAuthorizationProvider({ recover: true });
        const contract = createRollbackRecoveryContract({
            authorizationService: createRollbackAuthorizationService({ provider })
        });
        await contract.authorizeRecovery({
            actor: createTestTrustedActor(),
            destinationOrgId: '00D1',
            snapshotId: 'snap-1',
            operationId: 'op-recover',
            reason: 'controlled lock recovery'
        });
        assert.strictEqual(provider.lastRequest.current.operationId, 'op-recover');
        assert.strictEqual(
            provider.lastRequest.current.action,
            ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER
        );
    });

    await runTest('caller-supplied actor cannot bypass provider', async () => {
        const callerBody = {
            actorId: 'admin',
            actorType: 'ADMIN',
            role: 'admin',
            authorized: true,
            source: 'req.body'
        };
        assert.strictEqual(
            resolveActorContext(callerBody).trustLevel,
            ACTOR_TRUST.UNAUTHENTICATED
        );
        const decision = await authzService({ rollback: true }).authorize({
            actor: callerBody,
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(decision.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
        const spoofTrusted = {
            trustLevel: ACTOR_TRUST.TRUSTED_ACTOR,
            actorId: 'from-body',
            source: 'http-body'
        };
        const spoofed = await authzService({ rollback: true }).authorize({
            actor: spoofTrusted,
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1'
        });
        assert.strictEqual(spoofed.decision, ROLLBACK_AUTHORIZATION_DECISION.DENIED);
        assert.strictEqual(spoofed.reasonCode, 'INVALID_ACTOR');
    });

    await runTest('caller-supplied salesforceStatus is not authoritative', async () => {
        const contract = createRollbackRecoveryContract({
            authorizationService: authzService({ reconcile: true }),
            deployStatusService: createUnavailableSalesforceDeployStatusService()
        });
        const resolved = await contract.resolveAuthoritativeEvidence({
            destinationOrgId: '00D1',
            salesforceDeploymentId: '0AfFAKE',
            callerSuppliedStatus: 'Succeeded'
        });
        assert.strictEqual(resolved.usable, false);
        assert.strictEqual(resolved.evidence.authoritative, false);
        assert.strictEqual(
            isAuthoritativeSalesforceEvidence({
                status: 'SUCCEEDED',
                authoritative: false,
                source: 'CALLER',
                salesforceDeploymentId: '0AfFAKE'
            }),
            false
        );
    });

    await runTest('recovery requires a non-empty reason', async () => {
        const contract = createRollbackRecoveryContract({
            authorizationService: authzService({ recover: true })
        });
        const missing = await contract.authorizeRecovery({
            actor: createTestTrustedActor(),
            destinationOrgId: '00D1',
            operationId: 'op-1',
            reason: '   '
        });
        assert.strictEqual(missing.allowed, false);
        assert.strictEqual(missing.authorization.reasonCode, 'REASON_REQUIRED');
        const ok = await contract.authorizeRecovery({
            actor: createTestTrustedActor(),
            destinationOrgId: '00D1',
            operationId: 'op-1',
            reason: 'stale lock after crash'
        });
        assert.strictEqual(ok.allowed, true);
    });

    await runTest('reconciliation requires authoritative evidence', async () => {
        const store = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({ getStore: () => store });
        const created = await ops.createOperation({
            destinationOrgId: '00D1',
            snapshotId: 'snap-1'
        });
        await ops.transitionToInProgress(created.operationId);
        await ops.markTerminal(created.operationId, {
            status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        });

        const wrapper = createAuthorizedRollbackReconciliation({
            operationService: ops,
            recoveryContract: createRollbackRecoveryContract({
                authorizationService: authzService({ reconcile: true }),
                deployStatusService: createUnavailableSalesforceDeployStatusService()
            })
        });
        const blocked = await wrapper.reconcileUnknownOperationAuthorized({
            actor: createTestTrustedActor(),
            operationId: created.operationId,
            destinationOrgId: '00D1',
            snapshotId: 'snap-1',
            salesforceStatus: 'Succeeded',
            salesforceDeploymentId: '0AfCALLER'
        });
        assert.strictEqual(blocked.blocked, true);
        assert.strictEqual(blocked.code, 'ROLLBACK_RECONCILE_EVIDENCE_UNAVAILABLE');

        const withEvidence = createAuthorizedRollbackReconciliation({
            operationService: ops,
            recoveryContract: createRollbackRecoveryContract({
                authorizationService: authzService({ reconcile: true }),
                deployStatusService: createTestSalesforceDeployStatusService({
                    status: SALESFORCE_DEPLOY_STATUS.SUCCEEDED,
                    salesforceDeploymentId: '0AfAUTH',
                    authoritative: true
                })
            })
        });
        const reconciled = await withEvidence.reconcileUnknownOperationAuthorized({
            actor: createTestTrustedActor(),
            operationId: created.operationId,
            destinationOrgId: '00D1',
            snapshotId: 'snap-1',
            salesforceStatus: 'Failed',
            salesforceDeploymentId: '0AfCALLER'
        });
        assert.strictEqual(reconciled.blocked, false);
        assert.strictEqual(
            reconciled.operation.status,
            ROLLBACK_OPERATION_STATUS.SUCCEEDED
        );
        assert.strictEqual(reconciled.evidence.salesforceDeploymentId, '0AfAUTH');
    });

    await runTest('UNKNOWN_RESULT is unchanged when evidence is unavailable', async () => {
        const store = createMemoryRollbackOperationStore();
        const ops = createRollbackOperationService({ getStore: () => store });
        const created = await ops.createOperation({
            destinationOrgId: '00D1',
            snapshotId: 'snap-1'
        });
        await ops.transitionToInProgress(created.operationId);
        await ops.markTerminal(created.operationId, {
            status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        });
        const wrapper = createAuthorizedRollbackReconciliation({
            operationService: ops,
            recoveryContract: createRollbackRecoveryContract({
                authorizationService: authzService({ reconcile: true }),
                deployStatusService: createUnavailableSalesforceDeployStatusService()
            })
        });
        await wrapper.reconcileUnknownOperationAuthorized({
            actor: createTestTrustedActor(),
            operationId: created.operationId,
            destinationOrgId: '00D1',
            salesforceStatus: 'Failed'
        });
        const current = await store.getOperation(created.operationId);
        assert.strictEqual(current.status, ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT);
    });

    await runTest('authorized lock recovery requires ROLLBACK_RECOVER and reason', async () => {
        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        lockService.acquire({
            destinationOrgId: '00D1',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.ROLLBACK
        });
        const denied = createAuthorizedLockRecovery({
            lockService,
            recoveryContract: createRollbackRecoveryContract({
                authorizationService: authzService({ rollback: true, recover: false })
            }),
            resolveVerifiedDestinationOrgId: async () => '00D1'
        });
        const blocked = await denied.recoverDestinationLock({
            actor: createTestTrustedActor(),
            destinationOrgId: '00D1',
            reason: 'operator recovery',
            operationId: 'op-1'
        });
        assert.strictEqual(blocked.released, false);
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00D1' }).status,
            'HELD'
        );

        const allowed = createAuthorizedLockRecovery({
            lockService,
            recoveryContract: createRollbackRecoveryContract({
                authorizationService: authzService({ recover: true })
            }),
            resolveVerifiedDestinationOrgId: async () => '00D1'
        });
        const released = await allowed.recoverDestinationLock({
            actor: createTestTrustedActor(),
            destinationOrgId: '00D1',
            reason: 'operator recovery',
            operationId: 'op-1'
        });
        assert.strictEqual(released.released, true);
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00D1' }).status,
            'RELEASED'
        );
    });

    await runTest('flag-on restore without actor is denied before Salesforce mutation', async () => {
        const { capture, sealed } = await sealEligible();
        let executions = 0;
        const restore = createDestinationSnapshotRestoreService({
            captureService: capture,
            getRollbackOperationStore: () => createMemoryRollbackOperationStore(),
            isSnapshotRollbackEnabled: () => true,
            isDurableSnapshotStorageReady: () => true,
            isDeploymentOrgLockEnabled: () => true,
            getOrgLockService: () =>
                createOrgLockService({ store: createMemoryOrgLockStore() }),
            resolveVerifiedDestinationOrgId: async () => '00D000000000001',
            runDeploymentExecution: async () => {
                executions += 1;
                throw new Error('must not execute');
            }
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com',
            actor: 'operator',
            userId: 'from-body'
        });
        assert.strictEqual(result.blocked, true);
        assert.strictEqual(result.code, ROLLBACK_CODE.AUTHORIZATION_DENIED);
        assert.strictEqual(executions, 0);
    });

    await runTest('flag-on restore with unavailable authz is blocked', async () => {
        const { capture, sealed } = await sealEligible();
        let executions = 0;
        const restore = createDestinationSnapshotRestoreService({
            captureService: capture,
            getRollbackOperationStore: () => createMemoryRollbackOperationStore(),
            isSnapshotRollbackEnabled: () => true,
            isDurableSnapshotStorageReady: () => true,
            isDeploymentOrgLockEnabled: () => true,
            getOrgLockService: () =>
                createOrgLockService({ store: createMemoryOrgLockStore() }),
            resolveVerifiedDestinationOrgId: async () => '00D000000000001',
            resolveTrustedActor: () => createTestTrustedActor(),
            getRollbackAuthorizationService: () =>
                getSharedRollbackAuthorizationService(),
            runDeploymentExecution: async () => {
                executions += 1;
                return { success: true };
            }
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.AUTHORIZATION_UNAVAILABLE);
        assert.strictEqual(executions, 0);
    });

    await runTest('flag OFF still returns DISABLED without authorization', async () => {
        const { capture, sealed } = await sealEligible();
        const restore = createDestinationSnapshotRestoreService({
            captureService: capture,
            isSnapshotRollbackEnabled: () => false,
            isDurableSnapshotStorageReady: () => true
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.DISABLED);
    });

    await runTest('audit context excludes tokens and request bodies', () => {
        const actor = createTestTrustedActor();
        const audit = buildRollbackAuditContext({
            actor,
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK,
            destinationOrgId: '00D1',
            snapshotId: 'snap-1',
            authorizationDecision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
            reason: 'test'
        });
        assert.strictEqual(audit.actorId, actor.actorId);
        assert.strictEqual(audit.refreshToken, undefined);
        assert.ok(!('accessToken' in audit));
        assert.ok(!('requestBody' in audit));
    });

    await runTest('existing rollback flag remains OFF', () => {
        assert.strictEqual(isSnapshotRollbackEnabled({}), false);
        assert.strictEqual(
            DURABLE_SNAPSHOT_STORAGE_CAPABILITY.rollbackProductionReady,
            false
        );
        assert.strictEqual(LOCK_PRODUCTION_DISTRIBUTED_READY, false);
    });
})();
