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
    createMemoryOrgLockStore
} = require('./deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createOrgLockService
} = require('./deploymentOrgLock/deploymentOrgLock.service');
const {
    createRollbackAuthorizationService
} = require('./deploymentSnapshot/rollbackAuthorization.service');
const {
    createTestRollbackAuthorizationProvider,
    createTestTrustedActor
} = require('./deploymentSnapshot/rollbackAuthorization.testProvider');
const { createDeploymentRollbackService } = require('./deploymentRollback.service');

const DEST = '00D000000000001';
const CREDENTIALS = {
    refreshToken: 'refresh-token',
    instanceUrl: 'https://dest.example.com',
    orgId: DEST
};

const FLOW_PATH = 'force-app/main/default/flows/Active_Customer.flow-meta.xml';

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

function packFlowXml(xml) {
    return packMemberFiles([
        {
            relativePath: FLOW_PATH,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

async function sealNewFlow(capture) {
    const expectedBytes = packFlowXml('<Flow xmlns="http://soap.sforce.com/2006/04/metadata"/>');
    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: DEST,
            sourceOrgId: '00D000000000002'
        },
        members: [
            {
                metadataType: 'Flow',
                metadataName: 'Active_Customer',
                filePath: FLOW_PATH,
                changeClass: CHANGE_CLASS.NEW,
                expectedAfterHash: hashBytes(expectedBytes),
                captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN
            }
        ]
    });

    return capture.sealSnapshot(ready.snapshotId);
}

function seedHistory(historyService, { snapshotId, manifestSummary }) {
    const historyId = historyService.createHistory({
        deploymentPackage: {
            deploymentMode: 'DEPLOY',
            destinationOrgId: DEST,
            sourceOrgId: '00D000000000002'
        },
        deploymentReadiness: {
            overallStatus: 'READY',
            canDeploy: true
        }
    });

    const updates = { snapshotId };

    if (manifestSummary !== undefined) {
        updates.manifestSummary = manifestSummary;
    }

    historyService.updateHistory(historyId, updates);
    historyService.completeHistory(historyId, {
        deploymentMode: 'DEPLOY',
        destinationOrgId: DEST,
        snapshotId,
        deploymentResult: {
            success: true,
            status: 'Succeeded',
            message: 'deployed'
        }
    });

    return historyId;
}

function createRollbackHarness({
    historyService,
    capture,
    retrieveDestinationMember
}) {
    const operationStore = createMemoryRollbackOperationStore();
    const lockService = createOrgLockService({
        store: createMemoryOrgLockStore()
    });

    const restoreService = createDestinationSnapshotRestoreService({
        getRollbackOperationStore: () => operationStore,
        captureService: capture,
        isSnapshotRollbackEnabled: () => true,
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
        resolveVerifiedDestinationOrgId: async () => DEST,
        startLockHeartbeat: () => () => {},
        refreshAccessToken: async () => ({
            accessToken: 'test-access-token',
            instanceUrl: CREDENTIALS.instanceUrl
        }),
        retrieveDestinationMember,
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
        historyService
    });

    return createDeploymentRollbackService({
        historyService,
        restoreService
    });
}

(async () => {
    await runTest(
        'executeRollback passes deploymentApiVersion 66.0 from manifestSummary to runRollback',
        async () => {
            let runRollbackArgs = null;
            const historyService = createDeploymentHistoryService({
                store: createMemoryDeploymentHistoryStore()
            });
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const sealed = await sealNewFlow(capture);
            const historyId = seedHistory(historyService, {
                snapshotId: sealed.snapshotId,
                manifestSummary: { apiVersion: '66.0', members: 1 }
            });

            const service = createDeploymentRollbackService({
                historyService,
                restoreService: {
                    async runRollback(args) {
                        runRollbackArgs = args;
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            await service.executeRollback({
                historyId,
                snapshotId: sealed.snapshotId,
                ...CREDENTIALS
            });

            assert.strictEqual(runRollbackArgs.deploymentApiVersion, '66.0');
        }
    );

    await runTest(
        'executeRollback passes deploymentApiVersion 61.0 from manifestSummary to runRollback',
        async () => {
            let runRollbackArgs = null;
            const historyService = createDeploymentHistoryService({
                store: createMemoryDeploymentHistoryStore()
            });
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const sealed = await sealNewFlow(capture);
            const historyId = seedHistory(historyService, {
                snapshotId: sealed.snapshotId,
                manifestSummary: { apiVersion: '61.0', members: 1 }
            });

            const service = createDeploymentRollbackService({
                historyService,
                restoreService: {
                    async runRollback(args) {
                        runRollbackArgs = args;
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            await service.executeRollback({
                historyId,
                snapshotId: sealed.snapshotId,
                ...CREDENTIALS
            });

            assert.strictEqual(runRollbackArgs.deploymentApiVersion, '61.0');
        }
    );

    await runTest(
        'executeRollback passes deploymentApiVersion null when manifestSummary is missing',
        async () => {
            let runRollbackArgs = null;
            const historyService = createDeploymentHistoryService({
                store: createMemoryDeploymentHistoryStore()
            });
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const sealed = await sealNewFlow(capture);
            const historyId = seedHistory(historyService, {
                snapshotId: sealed.snapshotId
            });

            const service = createDeploymentRollbackService({
                historyService,
                restoreService: {
                    async runRollback(args) {
                        runRollbackArgs = args;
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            await service.executeRollback({
                historyId,
                snapshotId: sealed.snapshotId,
                ...CREDENTIALS
            });

            assert.strictEqual(runRollbackArgs.deploymentApiVersion, null);
        }
    );

    await runTest(
        'executeRollback passes deploymentApiVersion null when manifestSummary has no apiVersion',
        async () => {
            let runRollbackArgs = null;
            const historyService = createDeploymentHistoryService({
                store: createMemoryDeploymentHistoryStore()
            });
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const sealed = await sealNewFlow(capture);
            const historyId = seedHistory(historyService, {
                snapshotId: sealed.snapshotId,
                manifestSummary: { members: 3, metadataTypes: 2 }
            });

            const service = createDeploymentRollbackService({
                historyService,
                restoreService: {
                    async runRollback(args) {
                        runRollbackArgs = args;
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            await service.executeRollback({
                historyId,
                snapshotId: sealed.snapshotId,
                ...CREDENTIALS
            });

            assert.strictEqual(runRollbackArgs.deploymentApiVersion, null);
        }
    );

    await runTest(
        'retrieveDestinationMember receives sourceApiVersion 66.0 from deployment history via executeRollback',
        async () => {
            const retrieveCalls = [];
            const historyService = createDeploymentHistoryService({
                store: createMemoryDeploymentHistoryStore()
            });
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const sealed = await sealNewFlow(capture);
            const historyId = seedHistory(historyService, {
                snapshotId: sealed.snapshotId,
                manifestSummary: { apiVersion: '66.0', members: 1 }
            });

            const service = createRollbackHarness({
                historyService,
                capture,
                retrieveDestinationMember: async (args) => {
                    retrieveCalls.push(args);
                    return {
                        artifactBytes: packFlowXml('<Flow drift/>'),
                        files: []
                    };
                }
            });

            const result = await service.executeRollback({
                historyId,
                snapshotId: sealed.snapshotId,
                ...CREDENTIALS
            });

            assert.strictEqual(retrieveCalls.length, 1);
            assert.strictEqual(retrieveCalls[0].sourceApiVersion, '66.0');
            assert.strictEqual(retrieveCalls[0].metadataType, 'Flow');
            assert.strictEqual(retrieveCalls[0].metadataName, 'Active_Customer');
            assert.ok(result.httpStatus === 200);
        }
    );
})();
