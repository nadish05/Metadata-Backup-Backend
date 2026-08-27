'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CONTROL_PLANE_ERROR_CODE } = require('../controlPlane/controlPlane.errors');
const {
    resetControlPlaneTestOverrides
} = require('../controlPlane/controlPlane.runtime');
const { LOCK_PRODUCTION_DISTRIBUTED_READY } = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    resolveLockConfig,
    resetSharedOrgLockServiceForTests
} = require('../deploymentOrgLock/deploymentOrgLock.resolver');
const { isSnapshotRollbackEnabled } = require('./snapshotRollback.flag');
const {
    STORAGE_MODE,
    CONTROL_ORG_SNAPSHOT_STORAGE_CAPABILITY
} = require('./snapshotStorageCapability');
const {
    STORAGE_MODE_ENV,
    DURABLE_ROOT_ENV,
    STORAGE_BACKEND,
    resolveSnapshotStorageConfig,
    isDurableSnapshotStorageReady
} = require('./snapshotStorage.config');
const {
    getSharedSnapshotAccess,
    resetSharedSnapshotAccessForTests
} = require('./snapshotAccess.service');
const {
    getSharedRollbackOperationStore,
    resetSharedRollbackOperationStoreForTests
} = require('./rollbackOperation.resolver');
const {
    resolveDefaultHistoryStore,
    resetDefaultHistoryStoreForTests,
    HISTORY_CONTROL_ORG_ENV
} = require('../deploymentHistory.persistence');
const { createMemorySnapshotMetadataStore } = require('./stores/memorySnapshotMetadataStore');
const { createFileSnapshotStores } = require('./stores/fileSnapshotStores');
const { assertMetadataStore } = require('./stores/snapshotMetadataStore');
const { assertBlobStore } = require('./stores/snapshotBlobStore');

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

function restoreEnv(previous) {
    Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    });
    resetSharedSnapshotAccessForTests();
    resetSharedRollbackOperationStoreForTests();
    resetDefaultHistoryStoreForTests();
    resetSharedOrgLockServiceForTests();
    resetControlPlaneTestOverrides();
}

(async () => {
    await runTest('25. CONTROL_ORG mode does not fall back to filesystem', async () => {
        const previous = {
            [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
            [DURABLE_ROOT_ENV]: process.env[DURABLE_ROOT_ENV],
            [HISTORY_CONTROL_ORG_ENV]: process.env[HISTORY_CONTROL_ORG_ENV],
            DEPLOYMENT_LOCK_STORE: process.env.DEPLOYMENT_LOCK_STORE,
            DEPLOYMENT_LOCK_ROOT: process.env.DEPLOYMENT_LOCK_ROOT
        };
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r73-control-org-'));
        process.env[STORAGE_MODE_ENV] = 'CONTROL_ORG';
        process.env[HISTORY_CONTROL_ORG_ENV] = 'true';
        process.env[DURABLE_ROOT_ENV] = root;
        process.env.DEPLOYMENT_LOCK_STORE = 'CONTROL_ORG';
        process.env.DEPLOYMENT_LOCK_ROOT = root;
        resetSharedSnapshotAccessForTests();
        resetSharedRollbackOperationStoreForTests();
        resetDefaultHistoryStoreForTests();
        resetSharedOrgLockServiceForTests();
        resetControlPlaneTestOverrides();

        try {
            const config = resolveSnapshotStorageConfig();
            assert.strictEqual(config.storageMode, STORAGE_MODE.CONTROL_ORG);
            assert.strictEqual(config.backend, STORAGE_BACKEND.CONTROL_ORG);
            assert.strictEqual(isDurableSnapshotStorageReady(), false);

            const access = getSharedSnapshotAccess();
            assert.strictEqual(
                access.getStorageCapability().storageMode,
                STORAGE_MODE.CONTROL_ORG
            );
            assert.strictEqual(
                access.getStorageCapability().rollbackProductionReady,
                false
            );
            assert.deepStrictEqual(
                { ...access.getStorageCapability() },
                { ...CONTROL_ORG_SNAPSHOT_STORAGE_CAPABILITY }
            );

            await assert.rejects(
                () => access.getSnapshot('snapshot_missing'),
                (error) =>
                    error.code ===
                    CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
            );

            const opStore = getSharedRollbackOperationStore();
            await assert.rejects(
                () => opStore.getOperation('rbo-missing'),
                (error) =>
                    error.code ===
                    CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
            );

            const historyStore = resolveDefaultHistoryStore();
            await assert.rejects(
                () => historyStore.create({ historyId: 'hist-control-org' }),
                (error) =>
                    error.code ===
                    CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
            );

            const lockConfig = resolveLockConfig();
            assert.strictEqual(lockConfig.controlOrgSelected, true);
            assert.strictEqual(lockConfig.filesystemReady, false);
            assert.strictEqual(lockConfig.productionDistributedReady, false);

            const leftover = fs.readdirSync(root);
            assert.deepStrictEqual(leftover, []);
            assert.strictEqual(LOCK_PRODUCTION_DISTRIBUTED_READY, false);
            assert.strictEqual(isSnapshotRollbackEnabled(), false);
        } finally {
            restoreEnv(previous);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await runTest('26. existing MEMORY behavior unchanged', () => {
        const previous = {
            [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
            [DURABLE_ROOT_ENV]: process.env[DURABLE_ROOT_ENV]
        };
        delete process.env[STORAGE_MODE_ENV];
        delete process.env[DURABLE_ROOT_ENV];
        resetSharedSnapshotAccessForTests();

        try {
            const config = resolveSnapshotStorageConfig();
            assert.strictEqual(config.storageMode, STORAGE_MODE.MEMORY);
            assert.strictEqual(config.backend, STORAGE_BACKEND.MEMORY);
            const store = createMemorySnapshotMetadataStore();
            assertMetadataStore(store);
            const capability = getSharedSnapshotAccess().getStorageCapability();
            assert.strictEqual(capability.storageMode, 'MEMORY');
            assert.strictEqual(capability.rollbackProductionReady, false);
        } finally {
            restoreEnv(previous);
        }
    });

    await runTest('27. existing FILESYSTEM behavior unchanged', () => {
        const previous = {
            [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
            [DURABLE_ROOT_ENV]: process.env[DURABLE_ROOT_ENV]
        };
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r73-fs-'));
        process.env[STORAGE_MODE_ENV] = 'DURABLE';
        process.env[DURABLE_ROOT_ENV] = root;
        resetSharedSnapshotAccessForTests();

        try {
            const config = resolveSnapshotStorageConfig();
            assert.strictEqual(config.storageMode, STORAGE_MODE.DURABLE);
            assert.strictEqual(config.backend, STORAGE_BACKEND.FILESYSTEM);
            assert.strictEqual(isDurableSnapshotStorageReady(), true);
            const stores = createFileSnapshotStores({ rootDir: root });
            assertMetadataStore(stores.metadataStore);
            assertBlobStore(stores.blobStore);
            const capability = getSharedSnapshotAccess().getStorageCapability();
            assert.strictEqual(capability.storageMode, 'DURABLE');
            assert.strictEqual(capability.backend, 'FILESYSTEM');
            assert.strictEqual(capability.rollbackProductionReady, false);
        } finally {
            restoreEnv(previous);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
})();
