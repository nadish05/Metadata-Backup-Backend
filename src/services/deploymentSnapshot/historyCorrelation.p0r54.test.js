'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createDeploymentHistoryService
} = require('../deploymentHistory.service');
const {
    createFileDeploymentHistoryStore
} = require('../deploymentHistoryStores/fileDeploymentHistoryStore');
const { createFileSnapshotStores } = require('./stores/fileSnapshotStores');
const { SNAPSHOT_STATUS } = require('./snapshot.types');
const {
    MEMORY_SNAPSHOT_STORAGE_CAPABILITY,
    DURABLE_SNAPSHOT_STORAGE_CAPABILITY,
    isRollbackProductionReady
} = require('./snapshotStorageCapability');
const {
    createDestinationSnapshotCaptureService
} = require('./destinationSnapshotCapture.service');

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'p0r54-corr-'));
}

const readyReadiness = {
    overallStatus: 'READY',
    canDeploy: true,
    blockingIssues: [],
    warnings: [],
    summary: {
        destinationConnectivity: 'PASS',
        metadataValidation: 'PASS',
        dependencyValidation: 'PASS'
    }
};

(async () => {
    await runTest('process restart after snapshot creation', async () => {
        const root = tempRoot();
        const snapshotStores = createFileSnapshotStores({ rootDir: root });
        await snapshotStores.metadataStore.createSnapshot({
            snapshotId: 'snapshot_created_only',
            status: SNAPSHOT_STATUS.CAPTURING,
            deploymentId: 'history_after_create'
        });

        const historyService = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = historyService.createHistory({
            deploymentPackage: {
                deploymentMode: 'DEPLOY',
                sourceOrgId: '00Dsource',
                destinationOrgId: '00Ddest'
            },
            deploymentReadiness: readyReadiness
        });
        historyService.updateHistory(historyId, {
            snapshotId: 'snapshot_created_only'
        });

        const restartedSnapshots = createFileSnapshotStores({ rootDir: root });
        const restartedHistory = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const snapshot = await restartedSnapshots.metadataStore.getSnapshot(
            'snapshot_created_only'
        );

        assert.strictEqual(snapshot.status, SNAPSHOT_STATUS.CAPTURING);
        assert.strictEqual(
            restartedHistory.findBySnapshotId('snapshot_created_only').historyId,
            historyId
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('process restart after snapshot sealing', async () => {
        const root = tempRoot();
        const snapshotStores = createFileSnapshotStores({ rootDir: root });
        await snapshotStores.metadataStore.createSnapshot({
            snapshotId: 'snapshot_sealed_only',
            status: SNAPSHOT_STATUS.READY,
            deploymentId: 'history_internal'
        });
        await snapshotStores.metadataStore.sealSnapshot('snapshot_sealed_only', {
            sealedAt: 'now'
        });

        const historyService = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = historyService.createHistory({
            deploymentPackage: {
                deploymentMode: 'DEPLOY',
                destinationOrgId: '00Ddest'
            },
            deploymentReadiness: readyReadiness
        });
        historyService.updateHistory(historyId, {
            snapshotId: 'snapshot_sealed_only'
        });

        const restartedSnapshots = createFileSnapshotStores({ rootDir: root });
        const restartedHistory = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const snapshot = await restartedSnapshots.metadataStore.getSnapshot(
            'snapshot_sealed_only'
        );

        assert.strictEqual(snapshot.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(snapshot.deploymentId, 'history_internal');
        assert.strictEqual(
            restartedHistory.getHistory(historyId).snapshotId,
            'snapshot_sealed_only'
        );
        assert.strictEqual(
            restartedHistory.getHistory(historyId).salesforceDeploymentId,
            null
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('flag OFF still runs deployment execution without snapshot work', async () => {
        let deployed = false;
        const service = createDestinationSnapshotCaptureService({
            isSnapshotCaptureOnDeployEnabled: () => false,
            captureService: {
                captureSnapshot: async () => {
                    throw new Error('snapshot must not initialize');
                }
            }
        });

        const result = await service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: { destinationOrgId: '00D1' },
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, true);
        assert.strictEqual(result.snapshot, null);
        assert.strictEqual(result.snapshotBlocked, false);
    });

    await runTest('rollbackProductionReady remains false', () => {
        assert.strictEqual(
            isRollbackProductionReady(MEMORY_SNAPSHOT_STORAGE_CAPABILITY),
            false
        );
        assert.strictEqual(
            isRollbackProductionReady(DURABLE_SNAPSHOT_STORAGE_CAPABILITY),
            false
        );
        assert.strictEqual(
            DURABLE_SNAPSHOT_STORAGE_CAPABILITY.rollbackProductionReady,
            false
        );
    });
})();
