'use strict';

const {
    isDurableSnapshotStorageReady,
    resolveSnapshotStorageConfig
} = require('./snapshotStorage.config');
const {
    createFileRollbackOperationStore
} = require('./stores/fileRollbackOperationStore');
const {
    createUnavailableRollbackOperationStore
} = require('./stores/unavailableRollbackOperationStore');

const UNAVAILABLE_MESSAGE =
    'Durable rollback operation storage is not configured.';

let cachedKey = null;
let cachedStore = null;

function getSharedRollbackOperationStore() {
    const ready = isDurableSnapshotStorageReady();
    const config = resolveSnapshotStorageConfig();
    const key = `${ready}:${config.rootDir || ''}`;

    if (cachedStore && cachedKey === key) {
        return cachedStore;
    }

    if (ready && config.rootDir) {
        cachedStore = createFileRollbackOperationStore({
            rootDir: config.rootDir
        });
    } else {
        cachedStore = createUnavailableRollbackOperationStore(
            UNAVAILABLE_MESSAGE
        );
    }

    cachedKey = key;

    return cachedStore;
}

function resetSharedRollbackOperationStoreForTests() {
    cachedKey = null;
    cachedStore = null;
}

module.exports = {
    getSharedRollbackOperationStore,
    resetSharedRollbackOperationStoreForTests,
    UNAVAILABLE_MESSAGE
};
