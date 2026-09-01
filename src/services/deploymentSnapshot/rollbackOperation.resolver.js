'use strict';

const {
    isDurableSnapshotStorageReady,
    resolveSnapshotStorageConfig
} = require('./snapshotStorage.config');
const { STORAGE_MODE } = require('./snapshotStorageCapability');
const {
    createFileRollbackOperationStore
} = require('./stores/fileRollbackOperationStore');
const {
    createUnavailableRollbackOperationStore
} = require('./stores/unavailableRollbackOperationStore');
const {
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const {
    createSalesforceControlPlaneRollbackOperationStore
} = require('../controlPlane/stores/salesforceControlPlaneRollbackOperationStore');
const { getSharedControlPlaneClient } = require('../controlPlane/controlPlane.runtime');

const UNAVAILABLE_MESSAGE =
    'Durable rollback operation storage is not configured.';

let cachedKey = null;
let cachedStore = null;
let cachedSalesforceInlineStore = null;

function getSharedRollbackOperationStore() {
    const config = resolveSnapshotStorageConfig();
    const ready = isDurableSnapshotStorageReady();
    const key = `${config.storageMode}:${ready}:${config.rootDir || ''}`;

    if (cachedStore && cachedKey === key) {
        return cachedStore;
    }

    if (config.storageMode === STORAGE_MODE.CONTROL_ORG) {
        cachedStore = createSalesforceControlPlaneRollbackOperationStore({
            getClient: () => getSharedControlPlaneClient()
        });
    } else if (ready && config.rootDir) {
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

function getSalesforceInlineRollbackOperationStore() {
    if (!cachedSalesforceInlineStore) {
        cachedSalesforceInlineStore = createMemoryRollbackOperationStore();
    }

    return cachedSalesforceInlineStore;
}

function resetSharedRollbackOperationStoreForTests() {
    cachedKey = null;
    cachedStore = null;
}

function resetSalesforceInlineRollbackOperationStoreForTests() {
    cachedSalesforceInlineStore = null;
}

module.exports = {
    getSharedRollbackOperationStore,
    getSalesforceInlineRollbackOperationStore,
    resetSharedRollbackOperationStoreForTests,
    resetSalesforceInlineRollbackOperationStoreForTests,
    UNAVAILABLE_MESSAGE
};
