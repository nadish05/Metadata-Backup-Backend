'use strict';

const assert = require('assert');

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
    createDeploymentHistoryService
} = require('./deploymentHistory.service');
const {
    createMemoryDeploymentHistoryStore
} = require('./deploymentHistoryStores/memoryDeploymentHistoryStore');
const {
    createDeploymentRollbackService,
    buildRollbackApiVersionDiagnostic
} = require('./deploymentRollback.service');
const { DEFAULT_API_VERSION } = require('../config/salesforce');
const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./deploymentSnapshot/snapshot.types');
const { packMemberFiles } = require('./deploymentSnapshot/destinationMemberArtifact.service');
const { hashBytes } = require('./deploymentSnapshot/snapshotIntegrity.service');

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

function captureConsoleLogs(fn) {
    const logs = [];
    const originalLog = console.log;

    console.log = (...args) => {
        logs.push(
            args
                .map((arg) =>
                    typeof arg === 'string' ? arg : JSON.stringify(arg)
                )
                .join(' ')
        );
    };

    return Promise.resolve()
        .then(fn)
        .then((result) => ({ logs, result, error: null }))
        .catch((error) => ({ logs, result: null, error }))
        .finally(() => {
            console.log = originalLog;
        });
}

function parseRollbackApiVersionDiagnostic(logs) {
    const line = logs.find((entry) =>
        entry.includes('ROLLBACK_API_VERSION_DIAGNOSTIC')
    );
    assert.ok(line, 'expected ROLLBACK_API_VERSION_DIAGNOSTIC log line');
    return JSON.parse(
        line.replace(/^ROLLBACK_API_VERSION_DIAGNOSTIC /, '')
    );
}

async function sealNewFlow(capture) {
    const expectedBytes = packMemberFiles([
        {
            relativePath: FLOW_PATH,
            bytes: Buffer.from(
                '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"/>',
                'utf8'
            )
        }
    ]);
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

function seedHistory(historyService, { snapshotId, manifestSummary, extra }) {
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

    const updates = { snapshotId, ...(extra || {}) };

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

(async () => {
    await runTest(
        'ROLLBACK_API_VERSION_DIAGNOSTIC reports manifest apiVersion 61.0',
        async () => {
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
                    async runRollback() {
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            const { logs } = await captureConsoleLogs(() =>
                service.executeRollback({
                    historyId,
                    snapshotId: sealed.snapshotId,
                    operationId: 'rbo-test-61',
                    ...CREDENTIALS
                })
            );

            const payload = parseRollbackApiVersionDiagnostic(logs);
            assert.strictEqual(
                payload.originalHistoryManifestApiVersion,
                '61.0'
            );
            assert.strictEqual(payload.deploymentApiVersion, '61.0');
            assert.strictEqual(
                payload.sourceApiVersionSelection,
                'EXPLICIT_FROM_HISTORY'
            );
            assert.strictEqual(payload.operationId, 'rbo-test-61');
            assert.strictEqual(payload.snapshotId, sealed.snapshotId);
            assert.strictEqual(payload.historyId, historyId);
            assert.strictEqual(payload.rollbackOfHistoryId, historyId);
            assert.strictEqual(payload.defaultApiVersion, DEFAULT_API_VERSION);
            assert.strictEqual(payload.sourceMetadataApiVersion, null);
            assert.strictEqual(
                payload.sourceMetadataApiVersionSource,
                'NOT_AVAILABLE_AT_ROLLBACK'
            );
        }
    );

    await runTest(
        'ROLLBACK_API_VERSION_DIAGNOSTIC reports manifest apiVersion 66.0',
        async () => {
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
                    async runRollback() {
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            const { logs } = await captureConsoleLogs(() =>
                service.executeRollback({
                    historyId,
                    snapshotId: sealed.snapshotId,
                    ...CREDENTIALS
                })
            );

            const payload = parseRollbackApiVersionDiagnostic(logs);
            assert.strictEqual(
                payload.originalHistoryManifestApiVersion,
                '66.0'
            );
            assert.strictEqual(payload.deploymentApiVersion, '66.0');
            assert.strictEqual(
                payload.sourceApiVersionSelection,
                'EXPLICIT_FROM_HISTORY'
            );
        }
    );

    await runTest(
        'ROLLBACK_API_VERSION_DIAGNOSTIC reports null manifest apiVersion when manifestSummary missing',
        async () => {
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
                    async runRollback() {
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            const { logs } = await captureConsoleLogs(() =>
                service.executeRollback({
                    historyId,
                    snapshotId: sealed.snapshotId,
                    ...CREDENTIALS
                })
            );

            const payload = parseRollbackApiVersionDiagnostic(logs);
            assert.strictEqual(
                payload.originalHistoryManifestApiVersion,
                null
            );
            assert.strictEqual(payload.deploymentApiVersion, null);
            assert.strictEqual(
                payload.sourceApiVersionSelection,
                'DEFAULT_FALLBACK'
            );
        }
    );

    await runTest(
        'buildRollbackApiVersionDiagnostic sourceApiVersionSelection cases',
        () => {
            const explicit = buildRollbackApiVersionDiagnostic({
                originalHistory: { manifestSummary: { apiVersion: '61.0' } },
                deploymentApiVersion: '61.0'
            });
            assert.strictEqual(
                explicit.sourceApiVersionSelection,
                'EXPLICIT_FROM_HISTORY'
            );

            const fallback = buildRollbackApiVersionDiagnostic({
                originalHistory: {},
                deploymentApiVersion: null
            });
            assert.strictEqual(
                fallback.sourceApiVersionSelection,
                'DEFAULT_FALLBACK'
            );
        }
    );

    await runTest(
        'ROLLBACK_API_VERSION_DIAGNOSTIC includes sourceMetadataApiVersion when present on history',
        async () => {
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
                manifestSummary: { apiVersion: '61.0' },
                extra: {
                    metadataSummary: { sourceMetadataApiVersion: '66.0' }
                }
            });

            const service = createDeploymentRollbackService({
                historyService,
                restoreService: {
                    async runRollback() {
                        return { blocked: true, code: 'ROLLBACK_BLOCKED_TEST' };
                    }
                }
            });

            const { logs } = await captureConsoleLogs(() =>
                service.executeRollback({
                    historyId,
                    snapshotId: sealed.snapshotId,
                    ...CREDENTIALS
                })
            );

            const payload = parseRollbackApiVersionDiagnostic(logs);
            assert.strictEqual(payload.sourceMetadataApiVersion, '66.0');
            assert.strictEqual(
                payload.sourceMetadataApiVersionSource,
                'history.metadataSummary.sourceMetadataApiVersion'
            );
        }
    );

    await runTest(
        'executeRollback runRollback args unchanged aside from prior wiring',
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
            assert.strictEqual(runRollbackArgs.snapshotId, sealed.snapshotId);
            assert.strictEqual(runRollbackArgs.rollbackOfHistoryId, historyId);
        }
    );
})();
