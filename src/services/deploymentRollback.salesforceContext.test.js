'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    SNAPSHOT_STATUS
} = require('./deploymentSnapshot/snapshot.types');
const { packMemberFiles } = require('./deploymentSnapshot/destinationMemberArtifact.service');
const {
    computeSnapshotIntegrityHash,
    hashBytes
} = require('./deploymentSnapshot/snapshotIntegrity.service');
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
const {
    createMemoryOrgLockStore
} = require('./deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createOrgLockService
} = require('./deploymentOrgLock/deploymentOrgLock.service');
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
    SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE
} = require('./deploymentSnapshot/salesforceRollbackSnapshotContext.service');
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

const DEST = '00D000000000001';
const SNAPSHOT_ID = 'snapshot_89df94c0-ddaa-47fa-be6b-43a07cf03e47';
const ARTIFACT_ID = `snapshots/${SNAPSHOT_ID}/destination-before/ApexClass/AccountService`;
const CREDENTIALS = {
    refreshToken: 'refresh-token',
    instanceUrl: 'https://dest.example.com',
    orgId: DEST
};

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

function buildSalesforcePayload({ snapshotId = SNAPSHOT_ID } = {}) {
    const artifactBytes = beforeBytes();
    const afterHash = hashBytes(afterBytes());
    const artifactId = `snapshots/${snapshotId}/destination-before/ApexClass/AccountService`;
    const member = {
        memberKey: 'ApexClass:AccountService',
        metadataType: 'ApexClass',
        metadataName: 'AccountService',
        filePath: 'force-app/main/default/classes/AccountService.cls',
        changeClass: CHANGE_CLASS.MODIFIED,
        existedBefore: true,
        destinationBeforeHash: hashBytes(artifactBytes),
        expectedAfterHash: afterHash,
        artifactId,
        artifactSize: artifactBytes.length,
        contentDocumentId: '069NS00000dtlPdYAI',
        captureStatus: 'CAPTURED'
    };
    const members = [member];
    const overallIntegrityHash = computeSnapshotIntegrityHash(members, {
        schemaVersion: 2
    });

    return {
        artifactBytes,
        artifactId,
        snapshotExport: {
            snapshotId,
            deploymentId: 'history-001',
            sourceOrgId: '00D000000000002',
            destinationOrgId: DEST,
            status: SNAPSHOT_STATUS.SEALED,
            schemaVersion: 2,
            snapshotVersion: 1,
            overallIntegrityHash,
            rollbackEligible: true,
            createdAt: '2026-08-31T00:00:00.000Z',
            completedAt: '2026-08-31T00:01:00.000Z',
            sealedAt: '2026-08-31T00:01:00.000Z',
            memberCount: 1,
            members
        },
        artifacts: {
            [artifactId]: {
                contentBase64: artifactBytes.toString('base64'),
                size: artifactBytes.length
            }
        }
    };
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

function createSalesforceHarness({
    retrieveBytes = afterBytes(),
    checkOnlySuccess = true,
    executeSuccess = true,
    historyService = createDeploymentHistoryService({
        store: createMemoryDeploymentHistoryStore()
    }),
    operationStore = createMemoryRollbackOperationStore(),
    lockService = createOrgLockService({
        store: createMemoryOrgLockStore()
    })
} = {}) {
    let executions = 0;
    let checkOnlyCalls = 0;
    let injectedCaptureService = null;
    let injectedDurableReady = null;

    const createRestoreService = (overrides = {}) => {
        if (overrides.captureService) {
            injectedCaptureService = overrides.captureService;
        }

        if (overrides.isDurableSnapshotStorageReady) {
            injectedDurableReady = overrides.isDurableSnapshotStorageReady;
        }

        return createDestinationSnapshotRestoreService({
            getRollbackOperationStore: () => operationStore,
            isSnapshotRollbackEnabled: () => true,
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
            resolveVerifiedDestinationOrgId: async () => DEST,
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
            historyService,
            ...overrides
        });
    };

    return {
        historyService,
        counts: () => ({ executions, checkOnlyCalls }),
        getInjectedCaptureService: () => injectedCaptureService,
        getInjectedDurableReady: () => injectedDurableReady,
        service: createDeploymentRollbackService({
            historyService,
            createRestoreService
        })
    };
}

(async () => {
    await runTest(
        'existing rollback path without snapshotExport remains unchanged',
        async () => {
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const ready = await capture.captureSnapshot({
                deploymentContext: {
                    destinationOrgId: DEST,
                    sourceOrgId: '00D000000000002'
                },
                members: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'AccountService',
                        filePath:
                            'force-app/main/default/classes/AccountService.cls',
                        changeClass: CHANGE_CLASS.MODIFIED,
                        destinationBeforeBytes: beforeBytes(),
                        expectedAfterHash: hashBytes(afterBytes())
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);

            let salesforceContextUsed = false;
            const restoreService = createDestinationSnapshotRestoreService({
                captureService: capture,
                isSnapshotRollbackEnabled: () => true,
                isDurableSnapshotStorageReady: () => true,
                historyService: createDeploymentHistoryService({
                    store: createMemoryDeploymentHistoryStore()
                })
            });
            const historyService = createDeploymentHistoryService({
                store: createMemoryDeploymentHistoryStore()
            });
            const historyId = seedOriginalHistory(historyService, {
                snapshotId: sealed.snapshotId,
                destinationOrgId: DEST
            });
            const service = createDeploymentRollbackService({
                historyService,
                restoreService,
                createRestoreService: () => {
                    salesforceContextUsed = true;
                    return restoreService;
                }
            });

            const result = await service.executeRollback({
                historyId,
                snapshotId: sealed.snapshotId,
                ...CREDENTIALS
            });

            assert.strictEqual(salesforceContextUsed, false);
            assert.ok(result.body.blocked === true || result.body.failed === true);
        }
    );

    await runTest(
        'Salesforce snapshotExport + artifacts inject captureService into restore factory',
        async () => {
            const harness = createSalesforceHarness();
            const { snapshotExport, artifacts } = buildSalesforcePayload();
            const historyId = seedOriginalHistory(harness.historyService, {
                snapshotId: SNAPSHOT_ID,
                destinationOrgId: DEST
            });

            await harness.service.executeRollback({
                historyId,
                snapshotId: SNAPSHOT_ID,
                snapshotExport,
                artifacts,
                ...CREDENTIALS
            });

            const injected = harness.getInjectedCaptureService();
            assert.ok(injected);
            assert.strictEqual(typeof injected.getArtifact, 'function');
            assert.strictEqual(
                harness.getInjectedDurableReady()(),
                true
            );
        }
    );

    await runTest('snapshotId mismatch with snapshotExport is rejected', async () => {
        const harness = createSalesforceHarness();
        const { snapshotExport, artifacts } = buildSalesforcePayload();
        snapshotExport.snapshotId = 'snapshot_export_other';
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: SNAPSHOT_ID,
            destinationOrgId: DEST
        });

        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: SNAPSHOT_ID,
            snapshotExport,
            artifacts,
            ...CREDENTIALS
        });

        assert.strictEqual(result.httpStatus, 400);
        assert.strictEqual(
            result.body.code,
            INPUT_CODE.SNAPSHOT_EXPORT_MISMATCH
        );
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest(
        'valid Salesforce artifact reaches restore path and completes rollback',
        async () => {
            const harness = createSalesforceHarness();
            const { snapshotExport, artifacts } = buildSalesforcePayload();
            const historyId = seedOriginalHistory(harness.historyService, {
                snapshotId: SNAPSHOT_ID,
                destinationOrgId: DEST
            });

            const result = await harness.service.executeRollback({
                historyId,
                snapshotId: SNAPSHOT_ID,
                snapshotExport,
                artifacts,
                ...CREDENTIALS
            });

            assert.strictEqual(result.httpStatus, 200);
            assert.strictEqual(result.body.success, true);
            assert.strictEqual(harness.counts().checkOnlyCalls, 1);
            assert.strictEqual(harness.counts().executions, 1);
        }
    );

    await runTest(
        'artifact bytes remain byte-for-byte identical through injected captureService',
        async () => {
            const harness = createSalesforceHarness();
            const { snapshotExport, artifacts, artifactBytes, artifactId } =
                buildSalesforcePayload();
            const historyId = seedOriginalHistory(harness.historyService, {
                snapshotId: SNAPSHOT_ID,
                destinationOrgId: DEST
            });

            await harness.service.executeRollback({
                historyId,
                snapshotId: SNAPSHOT_ID,
                snapshotExport,
                artifacts,
                ...CREDENTIALS
            });

            const injected = harness.getInjectedCaptureService();
            const stored = await injected.getArtifact(SNAPSHOT_ID, artifactId);

            assert.ok(Buffer.isBuffer(stored));
            assert.ok(stored.equals(artifactBytes));
        }
    );

    await runTest(
        'stored member captureStatus is COMPLETE after Salesforce CAPTURED input',
        async () => {
            const harness = createSalesforceHarness();
            const { snapshotExport, artifacts } = buildSalesforcePayload();
            const historyId = seedOriginalHistory(harness.historyService, {
                snapshotId: SNAPSHOT_ID,
                destinationOrgId: DEST
            });

            await harness.service.executeRollback({
                historyId,
                snapshotId: SNAPSHOT_ID,
                snapshotExport,
                artifacts,
                ...CREDENTIALS
            });

            const injected = harness.getInjectedCaptureService();
            const members = await injected.getMembers(SNAPSHOT_ID);

            assert.strictEqual(
                members[0].captureStatus,
                MEMBER_CAPTURE_STATUS.COMPLETE
            );
        }
    );

    await runTest('Stage 2A validation errors propagate as rollback input errors', async () => {
        const harness = createSalesforceHarness();
        const { snapshotExport } = buildSalesforcePayload();
        const historyId = seedOriginalHistory(harness.historyService, {
            snapshotId: SNAPSHOT_ID,
            destinationOrgId: DEST
        });

        const result = await harness.service.executeRollback({
            historyId,
            snapshotId: SNAPSHOT_ID,
            snapshotExport,
            artifacts: {},
            ...CREDENTIALS
        });

        assert.strictEqual(result.httpStatus, 400);
        assert.strictEqual(result.body.blocked, true);
        assert.strictEqual(
            result.body.code,
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_MISSING
        );
        assert.strictEqual(harness.counts().executions, 0);
    });

    await runTest(
        'snapshotExport without artifacts uses existing restore path',
        async () => {
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const ready = await capture.captureSnapshot({
                deploymentContext: { destinationOrgId: DEST },
                members: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'AccountService',
                        filePath:
                            'force-app/main/default/classes/AccountService.cls',
                        changeClass: CHANGE_CLASS.MODIFIED,
                        destinationBeforeBytes: beforeBytes(),
                        expectedAfterHash: hashBytes(afterBytes())
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);

            let restoreFactoryCalled = false;
            const restoreService = createDestinationSnapshotRestoreService({
                captureService: capture,
                isSnapshotRollbackEnabled: () => true,
                isDurableSnapshotStorageReady: () => true,
                historyService: createDeploymentHistoryService({
                    store: createMemoryDeploymentHistoryStore()
                })
            });
            const historyService = createDeploymentHistoryService({
                store: createMemoryDeploymentHistoryStore()
            });
            const historyId = seedOriginalHistory(historyService, {
                snapshotId: sealed.snapshotId,
                destinationOrgId: DEST
            });
            const { snapshotExport } = buildSalesforcePayload({
                snapshotId: sealed.snapshotId
            });
            const service = createDeploymentRollbackService({
                historyService,
                restoreService,
                createRestoreService: () => {
                    restoreFactoryCalled = true;
                    return restoreService;
                }
            });

            await service.executeRollback({
                historyId,
                snapshotId: sealed.snapshotId,
                snapshotExport,
                ...CREDENTIALS
            });

            assert.strictEqual(restoreFactoryCalled, false);
        }
    );
})();
