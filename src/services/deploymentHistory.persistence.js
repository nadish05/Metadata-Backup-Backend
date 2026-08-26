'use strict';

const {
    createMemoryDeploymentHistoryStore
} = require('./deploymentHistoryStores/memoryDeploymentHistoryStore');
const {
    createFileDeploymentHistoryStore
} = require('./deploymentHistoryStores/fileDeploymentHistoryStore');
const {
    createSalesforceControlPlaneDeploymentHistoryStore
} = require('./controlPlane/stores/salesforceControlPlaneDeploymentHistoryStore');
const { getSharedControlPlaneClient } = require('./controlPlane/controlPlane.runtime');

const CAPTURE_FLAG_ENV = 'SNAPSHOT_CAPTURE_ON_DEPLOY';
const STORAGE_MODE_ENV = 'SNAPSHOT_STORAGE_MODE';
const DURABLE_ROOT_ENV = 'SNAPSHOT_DURABLE_ROOT';

function parseEnvBool(value, defaultValue) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = String(value).trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function shouldUseDurableDeploymentHistory(env = process.env) {
    const captureEnabled = parseEnvBool(env[CAPTURE_FLAG_ENV], false);

    if (!captureEnabled) {
        return false;
    }

    const storageMode = String(env[STORAGE_MODE_ENV] || 'MEMORY')
        .trim()
        .toUpperCase();
    const rootDir = String(env[DURABLE_ROOT_ENV] || '').trim();

    return storageMode === 'DURABLE' && Boolean(rootDir);
}

const sharedMemoryStore = createMemoryDeploymentHistoryStore();

let cachedDurableKey = null;
let cachedDurableStore = null;
let cachedControlOrgStore = null;

function resolveDefaultHistoryStore(env = process.env) {
    const storageMode = String(env[STORAGE_MODE_ENV] || 'MEMORY')
        .trim()
        .toUpperCase();

    if (storageMode === 'CONTROL_ORG') {
        if (!cachedControlOrgStore) {
            cachedControlOrgStore = createSalesforceControlPlaneDeploymentHistoryStore({
                getClient: () => getSharedControlPlaneClient()
            });
        }

        return cachedControlOrgStore;
    }

    if (!shouldUseDurableDeploymentHistory(env)) {
        return sharedMemoryStore;
    }

    const rootDir = String(env[DURABLE_ROOT_ENV] || '').trim();
    const key = `DURABLE:${rootDir}`;

    if (cachedDurableStore && cachedDurableKey === key) {
        return cachedDurableStore;
    }

    cachedDurableStore = createFileDeploymentHistoryStore({ rootDir });
    cachedDurableKey = key;

    return cachedDurableStore;
}

function resetDefaultHistoryStoreForTests() {
    sharedMemoryStore.clear();
    cachedDurableKey = null;
    cachedDurableStore = null;
    cachedControlOrgStore = null;
}

module.exports = {
    CAPTURE_FLAG_ENV,
    STORAGE_MODE_ENV,
    DURABLE_ROOT_ENV,
    parseEnvBool,
    shouldUseDurableDeploymentHistory,
    resolveDefaultHistoryStore,
    resetDefaultHistoryStoreForTests,
    getSharedMemoryHistoryStore: () => sharedMemoryStore
};
