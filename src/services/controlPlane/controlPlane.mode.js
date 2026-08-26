'use strict';

const CONTROL_ORG_MODE = 'CONTROL_ORG';
const DURABLE_MODE = 'DURABLE';
const MEMORY_MODE = 'MEMORY';

function normalizeMode(value) {
    return String(value || '').trim().toUpperCase();
}

function isControlOrgStorageMode(env = process.env) {
    return normalizeMode(env.SNAPSHOT_STORAGE_MODE) === CONTROL_ORG_MODE;
}

function isControlOrgLockStore(env = process.env) {
    return normalizeMode(env.DEPLOYMENT_LOCK_STORE) === CONTROL_ORG_MODE;
}

function resolveControlPlaneStorageMode(env = process.env) {
    const snapshotMode = normalizeMode(env.SNAPSHOT_STORAGE_MODE);

    if (snapshotMode === CONTROL_ORG_MODE) {
        return CONTROL_ORG_MODE;
    }

    if (snapshotMode === DURABLE_MODE) {
        return DURABLE_MODE;
    }

    return MEMORY_MODE;
}

module.exports = {
    CONTROL_ORG_MODE,
    isControlOrgLockStore,
    isControlOrgStorageMode,
    resolveControlPlaneStorageMode
};
