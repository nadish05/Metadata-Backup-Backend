'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
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
const { ROLLBACK_OPERATION_STATUS } = require('./deploymentSnapshot/rollbackOperation.types');
const {
    createMemoryOrgLockStore
} = require('./deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createOrgLockService
} = require('./deploymentOrgLock/deploymentOrgLock.service');
const { OPERATION_TYPE } = require('./deploymentOrgLock/deploymentOrgLock.types');
const {
    createDeploymentHistoryService
} = require('./deploymentHistory.service');
const {
    createMemoryDeploymentHistoryStore
} = require('./deploymentHistoryStores/memoryDeploymentHistoryStore');
const {
    createMemoryRollbackOperationStore
} = require('./deploymentSnapshot/stores/memoryRollbackOperationStore');
const {
    createRollbackAuthorizationService
} = require('./deploymentSnapshot/rollbackAuthorization.service');
const {
    createTestRollbackAuthorizationProvider,
    createTestTrustedActor
} = require('./deploymentSnapshot/rollbackAuthorization.testProvider');
const {
    INPUT_CODE,
    createDeploymentRollbackService
} = require('./deploymentRollback.service');

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

async function sealModified(capture = createSnapshotCaptureService({
    metadataStore: createMemorySnapshotMetadataStore(),
    blobStore: createMemorySnapshotBlobStore()
})) {
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

function seedOriginalHistory(historyService, { snapshotId, destinationOrgId }) {
    const historyId = historyService.createHistory({
        deploymentPackage: {
            deploymentMode: 'DEPLOY',
            destinationOrgId,
            sourceOrgId: '00D000000000002'
        },
        deploymentReadiness: {
            overallStatus: 'READY',
            canDeploy: true
        }
    });

    historyService.updateHistory(historyId, { snapshotId });
    historyService.completeHistory(historyId, {
        deploymentMode: 'DEPLOY',
        destinationOrgId,
        snapshotId,
        deploymentResult: {
            success: true,
            status: 'Succeeded',
            message: 'deployed'
        }
    });

    return historyId;
}

function createHarness({
    capture,
    retrieveBytes = afterBytes(),
    checkOnlySuccess = true,
    executeSuccess = true,
    identityOrgId = '00D000000000001',
    historyService = createDeploymentHistoryService({
        store: createMemoryDeploymentHistoryStore()
    }),
    operationStore = createMemoryRollbackOperationStore(),
    lockService = createOrgLockService({
        store: createMemoryOrgLockStore()
    }),
    rollbackEnabled = true
} = {}) {
    let executions = 0;
    let checkOnlyCalls = 0;
    const restoreService = createDestinationSnapshotRestoreService({
        getRollbackOperationStore: () => operationStore,
        captureService: capture,
        isSnapshotRollbackEnabled: () => rollbackEnabled,
        isDurableSnapshotStorageReady: () => true,
        isDeploymentOrgLockEnabled: () => true,
        getOrgLockService: () => lockService,
        createOwnerId: () => 'rollback-owner',
        getRollbackAuthorizationService: () =>
            createRollbackAuthorizationService({
                provider: createTestRollbackAuthorizationProvider({
                    rollback: true
                })
            }),
        resolveTrustedActor: () => createTestTrustedActor(),
        resolveVerifiedDestinationOrgId: async () => identityOrgId,
        startLockHeartbeat: () => () => {},
        retrieveDestinationMember: async () => ({
            artifactBytes: retrieveBytes,
            files: []
        }),
        runCheckOnlyDeployment: async () => {
            checkOnlyCalls += 1;
            return {
                executed: true,
                success: checkOnlySuccess,
                status: checkOnlySuccess ? 'Succeeded' : 'Failed',
                message: checkOnlySuccess ? 'ok' : 'check-only failed'
            };
        },
        runDeploymentExecution: async () => {
            executions += 1;
            return {
                success: executeSuccess,
                status: executeSuccess ? 'Succeeded' : 'Failed',
                message: executeSuccess ? 'deployed' : 'deploy failed'
            };
        },
        historyService
    });

    return {
        historyService,
        restoreService,
        operationStore,
        counts: () => ({ executions, checkOnlyCalls }),
        service: createDeploymentRollbackService({
            historyService,
            restoreService
        })
    };
}

const DEST = '00D000000000001';
const CREDENTIALS = {
    refreshToken: 'refresh-token',
    instanceUrl: 'https://dest.example.com',
    orgId: DEST
};

(async () => {
    await runTest('1. missing historyId is rejected', async () => {
        const harness = createHarness({
            capture: (await sealModified()).capture
        });
        const result = await harness.service.executeRollback({
            snapshotId: 'snapshot_x',
            ...CREDENTIALS
        });

        assert.strictEqual(result.httpStatus, 400);
        assert.strictEqual(result.body.code, INPUT_CODE.HISTORY_ID_REQUIRED);
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('2. missing snapshotId is rejected when history has none', async () => {
        const historyService = createDeploymentHistoryService({
            store: createMemoryDeploymentHistoryStore()
        });
        const historyId = historyService.createHistory({
            deploymentPackage: {
                deploymentMode: 'DEPLOY',
                destinationOrgId: DEST
            },
            deploymentReadiness: { overallStatus: 'READY', canDeploy: true }
        });
        const harness = createHarness({
            capture: (await sealModified()).capture,
            historyService
        });
        const result = await harness.service.executeRollback({
            historyId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.httpStatus, 400);
        assert.strictEqual(result.body.code, INPUT_CODE.SNAPSHOT_ID_REQUIRED);
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('3. missing destination credentials are rejected', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({ capture });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });

        const missingToken = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            instanceUrl: CREDENTIALS.instanceUrl,
            orgId: DEST
        });
        assert.strictEqual(missingToken.httpStatus, 400);
        assert.strictEqual(
            missingToken.body.code,
            INPUT_CODE.DESTINATION_CREDENTIALS_REQUIRED
        );

        const missingOrg = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            refreshToken: CREDENTIALS.refreshToken,
            instanceUrl: CREDENTIALS.instanceUrl
        });
        assert.strictEqual(
            missingOrg.body.code,
            INPUT_CODE.DESTINATION_CREDENTIALS_REQUIRED
        );
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('4. snapshot not SEALED is blocked', async () => {
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const capturing = await capture.createSnapshot({
            destinationOrgId: DEST
        });
        const harness = createHarness({ capture });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: capturing.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: capturing.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.httpStatus, 200);
        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(result.body.code, ROLLBACK_CODE.SNAPSHOT_NOT_SEALED);
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('5. rollbackEligible=false is blocked', async () => {
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const ready = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: DEST },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'NewService',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]
        });
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        assert.strictEqual(sealed.rollbackEligible, false);

        const harness = createHarness({ capture });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(
            result.body.code,
            ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE
        );
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('6. NEW member is blocked', async () => {
        const { capture, sealed } = await sealModified();
        const wrappedCapture = {
            getSnapshot: async (snapshotId) => {
                const snapshot = await capture.getSnapshot(snapshotId);
                return { ...snapshot, rollbackEligible: true };
            },
            getMembers: async () => [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService',
                    changeClass: CHANGE_CLASS.NEW,
                    existedBefore: false,
                    captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
                    destinationBeforeHash: null,
                    expectedAfterHash: null,
                    artifactId: null
                }
            ],
            getArtifact: (...args) => capture.getArtifact(...args),
            verifySnapshotIntegrity: (...args) =>
                capture.verifySnapshotIntegrity(...args)
        };
        const historyService = createDeploymentHistoryService({
            store: createMemoryDeploymentHistoryStore()
        });
        const restoreService = createDestinationSnapshotRestoreService({
            getRollbackOperationStore: () => createMemoryRollbackOperationStore(),
            captureService: wrappedCapture,
            isSnapshotRollbackEnabled: () => true,
            isDurableSnapshotStorageReady: () => true,
            isDeploymentOrgLockEnabled: () => true,
            getOrgLockService: () =>
                createOrgLockService({ store: createMemoryOrgLockStore() }),
            createOwnerId: () => 'rollback-owner',
            getRollbackAuthorizationService: () =>
                createRollbackAuthorizationService({
                    provider: createTestRollbackAuthorizationProvider({
                        rollback: true
                    })
                }),
            resolveTrustedActor: () => createTestTrustedActor(),
            resolveVerifiedDestinationOrgId: async () => DEST,
            startLockHeartbeat: () => () => {},
            historyService
        });
        const service = createDeploymentRollbackService({
            historyService,
            restoreService
        });
        const historyId = seedOriginalHistory(historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(result.body.code, ROLLBACK_CODE.NEW_MEMBER_PRESENT);
    });

    await runTest('7. unsupported metadata type is blocked', async () => {
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const packed = beforeBytes();
        const ready = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: DEST },
            members: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Onboarding',
                    filePath: 'force-app/main/default/flows/Onboarding.flow-meta.xml',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: packed,
                    expectedAfterHash: hashBytes(afterBytes())
                }
            ]
        });
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        const harness = createHarness({ capture });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(
            result.body.code,
            ROLLBACK_CODE.UNSUPPORTED_METADATA
        );
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('8. destination org mismatch is blocked', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({
            capture,
            identityOrgId: '00D000000000099'
        });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(
            result.body.code,
            ROLLBACK_CODE.DESTINATION_MISMATCH
        );
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('8b. history destination mismatch is rejected before restore', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({ capture });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            refreshToken: CREDENTIALS.refreshToken,
            instanceUrl: CREDENTIALS.instanceUrl,
            orgId: '00D000000000099'
        });

        assert.strictEqual(result.httpStatus, 400);
        assert.strictEqual(
            result.body.code,
            INPUT_CODE.HISTORY_DESTINATION_MISMATCH
        );
        assert.strictEqual(harness.counts().checkOnlyCalls, 0);
    });

    await runTest('9. destination drift from expected-after is blocked', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({
            capture,
            retrieveBytes: beforeBytes()
        });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(result.body.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('10. successful MODIFIED restore uses mocked deployment engine', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({ capture });
        const originalId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const originalBefore = harness.historyService.getHistory(originalId);
        const result = await harness.service.executeRollback({
            historyId: originalId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.httpStatus, 200);
        assert.strictEqual(result.body.success, true);
        assert.strictEqual(result.body.blocked, false);
        assert.strictEqual(result.body.failed, false);
        assert.strictEqual(harness.counts().checkOnlyCalls, 1);
        assert.strictEqual(harness.counts().executions, 1);
        assert.ok(result.body.historyId);
        assert.notStrictEqual(result.body.historyId, originalId);
        assert.strictEqual(result.body.rollbackOfHistoryId, originalId);
        assert.strictEqual(
            result.body.deploymentHistory.rollbackOfHistoryId,
            originalId
        );
        assert.strictEqual(
            result.body.deploymentHistory.operationType,
            OPERATION_TYPE.ROLLBACK
        );
        assert.strictEqual(result.body.deploymentHistory.deploymentMode, 'DEPLOY');
        assert.strictEqual(result.body.deploymentHistory.snapshotId, null);

        const originalAfter = harness.historyService.getHistory(originalId);
        assert.strictEqual(originalAfter.status, originalBefore.status);
        assert.strictEqual(originalAfter.snapshotId, sealed.snapshotId);
        assert.strictEqual(originalAfter.historyId, originalId);
        assert.strictEqual(originalAfter.rollbackOfHistoryId, null);
    });

    await runTest('11. check-only failure does not execute deployment', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({
            capture,
            checkOnlySuccess: false
        });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(result.body.code, ROLLBACK_CODE.CHECK_ONLY_FAILED);
        assert.strictEqual(harness.counts().checkOnlyCalls, 1);
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('12. duplicate rollback is blocked', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({ capture });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const first = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });
        assert.strictEqual(first.body.success, true);

        const second = await harness.service.executeRollback({
            historyId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });
        assert.strictEqual(second.body.blocked, true);
        assert.strictEqual(
            second.body.code,
            ROLLBACK_CODE.ALREADY_COMPLETED
        );
        assert.strictEqual(harness.counts().executions, 1);
        assert.strictEqual(
            second.body.operationStatus,
            ROLLBACK_OPERATION_STATUS.SUCCEEDED
        );
    });

    await runTest('13-14. rollback history uses Rollback_Of_History_Id and does not overwrite original', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({ capture });
        const originalId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const original = harness.historyService.getHistory(originalId);
        const result = await harness.service.executeRollback({
            historyId: originalId,
            snapshotId: sealed.snapshotId,
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.rollbackOfHistoryId, originalId);
        assert.strictEqual(
            result.body.deploymentHistory.rollbackOfHistoryId,
            originalId
        );

        const stillOriginal = harness.historyService.getHistory(originalId);
        assert.deepStrictEqual(
            {
                historyId: stillOriginal.historyId,
                snapshotId: stillOriginal.snapshotId,
                status: stillOriginal.status,
                rollbackOfHistoryId: stillOriginal.rollbackOfHistoryId
            },
            {
                historyId: original.historyId,
                snapshotId: original.snapshotId,
                status: original.status,
                rollbackOfHistoryId: original.rollbackOfHistoryId
            }
        );
        assert.notStrictEqual(result.body.historyId, originalId);
    });

    await runTest('history snapshot mismatch is rejected', async () => {
        const { capture, sealed } = await sealModified();
        const harness = createHarness({ capture });
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: sealed.snapshotId,
            destinationOrgId: DEST
        });
        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: 'snapshot_other',
            ...CREDENTIALS
        });

        assert.strictEqual(result.httpStatus, 400);
        assert.strictEqual(
            result.body.code,
            INPUT_CODE.HISTORY_SNAPSHOT_MISMATCH
        );
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest('production default remains fail-closed without enabling flags', async () => {
        const historyService = createDeploymentHistoryService({
            store: createMemoryDeploymentHistoryStore()
        });
        const service = createDeploymentRollbackService({
            historyService,
            restoreService: createDestinationSnapshotRestoreService({
                isSnapshotRollbackEnabled: () => false,
                historyService
            })
        });
        const result = await service.executeRollback({
            historyId: 'history_test',
            snapshotId: 'snapshot_test',
            ...CREDENTIALS
        });

        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(result.body.success, false);
        assert.strictEqual(result.body.code, ROLLBACK_CODE.DISABLED);
    });
})();
