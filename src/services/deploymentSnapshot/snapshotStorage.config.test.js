'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

const {
    STORAGE_MODE
} = require('./snapshotStorageCapability');
const {
    STORAGE_MODE_ENV,
    DURABLE_ROOT_ENV,
    resolveSnapshotStorageConfig,
    isDurableSnapshotStorageReady
} = require('./snapshotStorage.config');
const {
    getSharedSnapshotAccess,
    resetSharedSnapshotAccessForTests
} = require('./snapshotAccess.service');
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

function restoreEnv(previousMode, previousRoot) {
    if (previousMode === undefined) {
        delete process.env[STORAGE_MODE_ENV];
    } else {
        process.env[STORAGE_MODE_ENV] = previousMode;
    }

    if (previousRoot === undefined) {
        delete process.env[DURABLE_ROOT_ENV];
    } else {
        process.env[DURABLE_ROOT_ENV] = previousRoot;
    }

    resetSharedSnapshotAccessForTests();
}

(async () => {
    await runTest('MEMORY mode is default and not durable', () => {
        const previousMode = process.env[STORAGE_MODE_ENV];
        const previousRoot = process.env[DURABLE_ROOT_ENV];
        delete process.env[STORAGE_MODE_ENV];
        delete process.env[DURABLE_ROOT_ENV];

        try {
            const config = resolveSnapshotStorageConfig();
            assert.strictEqual(config.storageMode, STORAGE_MODE.MEMORY);
            assert.strictEqual(isDurableSnapshotStorageReady(), false);
        } finally {
            restoreEnv(previousMode, previousRoot);
        }
    });

    await runTest('DURABLE without root is not ready', () => {
        const previousMode = process.env[STORAGE_MODE_ENV];
        const previousRoot = process.env[DURABLE_ROOT_ENV];
        process.env[STORAGE_MODE_ENV] = 'DURABLE';
        delete process.env[DURABLE_ROOT_ENV];
        resetSharedSnapshotAccessForTests();

        try {
            assert.strictEqual(isDurableSnapshotStorageReady(), false);
            const capability = getSharedSnapshotAccess().getStorageCapability();
            assert.strictEqual(capability.durable, false);
            assert.strictEqual(capability.configured, false);
            assert.strictEqual(capability.rollbackProductionReady, false);
        } finally {
            restoreEnv(previousMode, previousRoot);
        }
    });

    await runTest('DURABLE with root reports durable capability', () => {
        const previousMode = process.env[STORAGE_MODE_ENV];
        const previousRoot = process.env[DURABLE_ROOT_ENV];
        const root = path.join(os.tmpdir(), 'p0r52-cap-root');
        process.env[STORAGE_MODE_ENV] = 'DURABLE';
        process.env[DURABLE_ROOT_ENV] = root;
        resetSharedSnapshotAccessForTests();

        try {
            assert.strictEqual(isDurableSnapshotStorageReady(), true);
            const left = getSharedSnapshotAccess();
            const right = getSharedSnapshotAccess();
            assert.strictEqual(left, right);
            const capability = left.getStorageCapability();
            assert.strictEqual(capability.storageMode, STORAGE_MODE.DURABLE);
            assert.strictEqual(capability.durable, true);
            assert.strictEqual(capability.shared, true);
            assert.strictEqual(capability.processLocal, false);
            assert.strictEqual(capability.rollbackProductionReady, false);
        } finally {
            restoreEnv(previousMode, previousRoot);
        }
    });

    await runTest('capture ON without durable storage blocks deploy', async () => {
        let deployed = false;
        let captured = false;
        const service = createDestinationSnapshotCaptureService({
            isSnapshotCaptureOnDeployEnabled: () => true,
            enforceDurableCapture: true,
            isDurableSnapshotStorageReady: () => false,
            captureService: {
                captureSnapshot: async () => {
                    captured = true;
                }
            }
        });

        const result = await service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: {
                destinationOrgId: '00D1',
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'AccountService',
                            filePath: 'classes/AccountService.cls'
                        }
                    ]
                }
            },
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(captured, false);
        assert.strictEqual(result.snapshotBlocked, true);
        assert.match(
            result.deploymentExecution.message,
            /durable snapshot storage is not configured/
        );
    });
})();
