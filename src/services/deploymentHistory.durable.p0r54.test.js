'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createDeploymentHistoryService,
    resetDefaultHistoryStoreForTests
} = require('./deploymentHistory.service');
const deploymentHistoryService = require('./deploymentHistory.service');
const {
    HistoryDuplicateError,
    HistoryCorrelationConflictError
} = require('./deploymentHistory.errors');
const {
    createFileDeploymentHistoryStore
} = require('./deploymentHistoryStores/fileDeploymentHistoryStore');
const {
    shouldUseDurableDeploymentHistory,
    CAPTURE_FLAG_ENV,
    STORAGE_MODE_ENV,
    DURABLE_ROOT_ENV
} = require('./deploymentHistory.persistence');
const {
    historyRecordContainsSecrets
} = require('./deploymentHistory.sanitize');

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'p0r54-history-'));
}

function restoreEnv(previous) {
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    resetDefaultHistoryStoreForTests();
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

function createPackage(overrides = {}) {
    return {
        deploymentMode: 'DEPLOY',
        sourceOrgId: '00Dsource',
        destinationOrgId: '00Ddest',
        sourceBranch: 'feature',
        destinationBranch: 'main',
        repoUrl: 'https://github.com/example/repo.git',
        ...overrides
    };
}

(async () => {
    await runTest('create durable history', () => {
        const root = tempRoot();
        const store = createFileDeploymentHistoryStore({ rootDir: root });
        const service = createDeploymentHistoryService({ store });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });

        assert.ok(historyId);
        const loaded = service.getHistory(historyId);
        assert.strictEqual(loaded.status, 'IN_PROGRESS');
        assert.strictEqual(loaded.snapshotId, null);
        assert.strictEqual(loaded.salesforceDeploymentId, null);
        assert.strictEqual(loaded.sourceOrgId, '00Dsource');
        assert.strictEqual(loaded.destinationOrgId, '00Ddest');
        assert.ok(
            fs.existsSync(path.join(root, 'history', `${historyId}.json`))
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('restart simulation loads history from second store instance', () => {
        const root = tempRoot();
        const first = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = first.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });

        const second = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const loaded = second.getHistory(historyId);

        assert.strictEqual(loaded.historyId, historyId);
        assert.strictEqual(loaded.destinationOrgId, '00Ddest');
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('history → snapshot lookup', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        service.updateHistory(historyId, { snapshotId: 'snapshot_abc' });

        const bySnapshot = service.findBySnapshotId('snapshot_abc');
        const byHistory = service.getHistory(historyId);

        assert.strictEqual(bySnapshot.historyId, historyId);
        assert.strictEqual(byHistory.snapshotId, 'snapshot_abc');
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('history → Salesforce deployment ID lookup', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        service.completeHistory(historyId, {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY', workspaceCreated: true },
            deploymentResult: {
                success: true,
                deploymentId: '0Af000LOOKUP'
            }
        });

        const loaded = service.getHistory(historyId);
        assert.strictEqual(loaded.deploymentId, '0Af000LOOKUP');
        assert.strictEqual(loaded.salesforceDeploymentId, '0Af000LOOKUP');
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('Salesforce deployment ID → history lookup', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        service.completeHistory(historyId, {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY' },
            deploymentResult: {
                success: true,
                deploymentId: '0Af000REVERSE'
            }
        });

        const found = service.findBySalesforceDeploymentId('0Af000REVERSE');
        assert.strictEqual(found.historyId, historyId);
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('snapshot correlation survives restart', () => {
        const root = tempRoot();
        const writer = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = writer.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        writer.updateHistory(historyId, { snapshotId: 'snapshot_restart' });

        const reader = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        assert.strictEqual(
            reader.findBySnapshotId('snapshot_restart').historyId,
            historyId
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('duplicate history creation is rejected', () => {
        const root = tempRoot();
        const store = createFileDeploymentHistoryStore({ rootDir: root });
        store.create({
            historyId: 'history_dup_1',
            status: 'IN_PROGRESS',
            snapshotId: null,
            salesforceDeploymentId: null
        });

        assert.throws(
            () =>
                store.create({
                    historyId: 'history_dup_1',
                    status: 'IN_PROGRESS'
                }),
            HistoryDuplicateError
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('idempotent snapshotId update', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        service.updateHistory(historyId, { snapshotId: 'snapshot_same' });
        service.updateHistory(historyId, { snapshotId: 'snapshot_same' });

        assert.strictEqual(
            service.getHistory(historyId).snapshotId,
            'snapshot_same'
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('idempotent Salesforce deployment completion', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        const completion = {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY' },
            deploymentResult: {
                success: true,
                deploymentId: '0Af000SAME',
                deploymentSummary: { deploymentStatus: 'Succeeded' }
            }
        };

        service.completeHistory(historyId, completion);
        service.completeHistory(historyId, completion);

        assert.strictEqual(
            service.getHistory(historyId).salesforceDeploymentId,
            '0Af000SAME'
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('conflicting Salesforce deploymentId update fails', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        service.completeHistory(historyId, {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY' },
            deploymentResult: { success: true, deploymentId: '0Af000FIRST' }
        });

        assert.throws(
            () =>
                service.completeHistory(historyId, {
                    deploymentReadiness: readyReadiness,
                    generatedWorkspace: { status: 'READY' },
                    deploymentResult: {
                        success: true,
                        deploymentId: '0Af000SECOND'
                    }
                }),
            HistoryCorrelationConflictError
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('Salesforce deployment failure persists sanitized failure state', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        service.updateHistory(historyId, { snapshotId: 'snapshot_failed_deploy' });

        const response = service.completeHistory(historyId, {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY' },
            deploymentResult: {
                success: false,
                status: 'FAILED',
                deploymentId: '0Af000FAIL',
                message: 'Component compile failed.',
                refreshToken: 'should-not-persist',
                accessToken: 'should-not-persist',
                deploymentSummary: { deploymentStatus: 'Failed' }
            }
        });

        const raw = fs.readFileSync(
            path.join(root, 'history', `${historyId}.json`),
            'utf8'
        );

        assert.strictEqual(response.status, 'FAILED');
        assert.strictEqual(response.salesforceDeploymentId, '0Af000FAIL');
        assert.strictEqual(
            service.getHistory(historyId).snapshotId,
            'snapshot_failed_deploy'
        );
        assert.strictEqual(historyRecordContainsSecrets(JSON.parse(raw)), false);
        assert.ok(!raw.includes('should-not-persist'));
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('no refreshToken or accessToken persisted anywhere', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: {
                ...createPackage(),
                refreshToken: 'pkg-refresh',
                accessToken: 'pkg-access'
            },
            deploymentReadiness: readyReadiness,
            deploymentSelections: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'Foo',
                    refreshToken: 'sel-refresh'
                }
            ]
        });
        service.updateHistory(historyId, {
            snapshotId: 'snapshot_secret_check'
        });
        service.completeHistory(historyId, {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY' },
            deploymentResult: {
                success: true,
                deploymentId: '0Af000SECRET',
                authorization: 'Bearer secret',
                refreshToken: 'result-refresh'
            }
        });

        const raw = fs.readFileSync(
            path.join(root, 'history', `${historyId}.json`),
            'utf8'
        );
        const parsed = JSON.parse(raw);

        assert.strictEqual(parsed.refreshToken, undefined);
        assert.strictEqual(parsed.accessToken, undefined);
        assert.ok(!raw.includes('pkg-refresh'));
        assert.ok(!raw.includes('pkg-access'));
        assert.ok(!raw.includes('sel-refresh'));
        assert.ok(!raw.includes('result-refresh'));
        assert.ok(!raw.includes('Bearer secret'));
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('shared filesystem root across two service instances', () => {
        const root = tempRoot();
        const left = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const right = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = left.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        left.updateHistory(historyId, { snapshotId: 'snapshot_shared' });

        assert.strictEqual(right.getHistory(historyId).snapshotId, 'snapshot_shared');
        assert.strictEqual(
            right.findBySnapshotId('snapshot_shared').historyId,
            historyId
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('path traversal attempts fail', () => {
        const root = tempRoot();
        const store = createFileDeploymentHistoryStore({ rootDir: root });

        assert.throws(
            () => store.create({ historyId: '../etc/passwd' }),
            TypeError
        );
        assert.throws(
            () => store.create({ historyId: '..\\windows' }),
            TypeError
        );
        assert.strictEqual(store.exists('../etc/passwd'), false);
        assert.strictEqual(store.get('..'), null);
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('partial/corrupt JSON is handled safely', () => {
        const root = tempRoot();
        const store = createFileDeploymentHistoryStore({ rootDir: root });
        store.create({
            historyId: 'history_good_1',
            status: 'IN_PROGRESS',
            startedAt: new Date().toISOString()
        });
        fs.mkdirSync(path.join(root, 'history'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'history', 'history_corrupt_1.json'),
            '{ not json'
        );

        const listed = store.list();
        assert.strictEqual(
            listed.some((item) => item.historyId === 'history_good_1'),
            true
        );
        assert.strictEqual(store.get('history_corrupt_1'), null);
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('conflicting snapshotId update fails', () => {
        const root = tempRoot();
        const service = createDeploymentHistoryService({
            store: createFileDeploymentHistoryStore({ rootDir: root })
        });
        const historyId = service.createHistory({
            deploymentPackage: createPackage(),
            deploymentReadiness: readyReadiness
        });
        service.updateHistory(historyId, { snapshotId: 'snapshot_one' });

        assert.throws(
            () =>
                service.updateHistory(historyId, {
                    snapshotId: 'snapshot_two'
                }),
            HistoryCorrelationConflictError
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('flag OFF does not initialize durable history', () => {
        const previous = {
            [CAPTURE_FLAG_ENV]: process.env[CAPTURE_FLAG_ENV],
            [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
            [DURABLE_ROOT_ENV]: process.env[DURABLE_ROOT_ENV]
        };
        const root = tempRoot();

        delete process.env[CAPTURE_FLAG_ENV];
        process.env[STORAGE_MODE_ENV] = 'DURABLE';
        process.env[DURABLE_ROOT_ENV] = root;
        resetDefaultHistoryStoreForTests();

        try {
            assert.strictEqual(shouldUseDurableDeploymentHistory(), false);
            const historyId = deploymentHistoryService.createHistory({
                deploymentPackage: createPackage(),
                deploymentReadiness: readyReadiness
            });
            assert.ok(historyId);
            assert.strictEqual(fs.existsSync(path.join(root, 'history')), false);
            assert.ok(deploymentHistoryService.getHistory(historyId));
        } finally {
            restoreEnv(previous);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await runTest('durable mode with capture ON uses filesystem history', () => {
        const previous = {
            [CAPTURE_FLAG_ENV]: process.env[CAPTURE_FLAG_ENV],
            [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
            [DURABLE_ROOT_ENV]: process.env[DURABLE_ROOT_ENV]
        };
        const root = tempRoot();
        process.env[CAPTURE_FLAG_ENV] = 'true';
        process.env[STORAGE_MODE_ENV] = 'DURABLE';
        process.env[DURABLE_ROOT_ENV] = root;
        resetDefaultHistoryStoreForTests();

        try {
            assert.strictEqual(shouldUseDurableDeploymentHistory(), true);
            const historyId = deploymentHistoryService.createHistory({
                deploymentPackage: createPackage(),
                deploymentReadiness: readyReadiness
            });
            assert.ok(
                fs.existsSync(path.join(root, 'history', `${historyId}.json`))
            );
        } finally {
            restoreEnv(previous);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
})();
