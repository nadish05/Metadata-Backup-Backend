'use strict';

/**
 * Persistence readiness for snapshot stores.
 * Memory adapters are development-only and are not production-rollback-ready.
 */

const STORAGE_MODE = Object.freeze({
    MEMORY: 'MEMORY',
    DURABLE: 'DURABLE'
});

const MEMORY_SNAPSHOT_STORAGE_CAPABILITY = Object.freeze({
    storageMode: STORAGE_MODE.MEMORY,
    backend: 'MEMORY',
    durable: false,
    shared: false,
    processLocal: true,
    configured: true,
    rollbackProductionReady: false
});

const DURABLE_SNAPSHOT_STORAGE_CAPABILITY = Object.freeze({
    storageMode: STORAGE_MODE.DURABLE,
    backend: 'FILESYSTEM',
    durable: true,
    shared: true,
    processLocal: false,
    configured: true,
    rollbackProductionReady: false
});

const DURABLE_UNCONFIGURED_SNAPSHOT_STORAGE_CAPABILITY = Object.freeze({
    storageMode: STORAGE_MODE.DURABLE,
    backend: 'FILESYSTEM',
    durable: false,
    shared: false,
    processLocal: true,
    configured: false,
    rollbackProductionReady: false
});

function isRollbackProductionReady(capability) {
    return capability?.rollbackProductionReady === true;
}

function buildSnapshotStorageCapability(config) {
    if (config?.storageMode === STORAGE_MODE.DURABLE && config?.rootDir) {
        return { ...DURABLE_SNAPSHOT_STORAGE_CAPABILITY };
    }

    if (config?.storageMode === STORAGE_MODE.DURABLE) {
        return { ...DURABLE_UNCONFIGURED_SNAPSHOT_STORAGE_CAPABILITY };
    }

    return { ...MEMORY_SNAPSHOT_STORAGE_CAPABILITY };
}

module.exports = {
    STORAGE_MODE,
    MEMORY_SNAPSHOT_STORAGE_CAPABILITY,
    DURABLE_SNAPSHOT_STORAGE_CAPABILITY,
    DURABLE_UNCONFIGURED_SNAPSHOT_STORAGE_CAPABILITY,
    isRollbackProductionReady,
    buildSnapshotStorageCapability
};
