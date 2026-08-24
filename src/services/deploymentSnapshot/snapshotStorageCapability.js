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
    durable: false,
    shared: false,
    processLocal: true,
    rollbackProductionReady: false
});

function isRollbackProductionReady(capability) {
    return capability?.rollbackProductionReady === true;
}

module.exports = {
    STORAGE_MODE,
    MEMORY_SNAPSHOT_STORAGE_CAPABILITY,
    isRollbackProductionReady
};
