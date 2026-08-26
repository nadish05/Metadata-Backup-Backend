'use strict';

const { STORAGE_MODE } = require('./snapshotStorageCapability');
const { parseEnvBool } = require('./snapshotCapture.flag');

const STORAGE_MODE_ENV = 'SNAPSHOT_STORAGE_MODE';
const DURABLE_ROOT_ENV = 'SNAPSHOT_DURABLE_ROOT';
const STORAGE_BACKEND = Object.freeze({
    MEMORY: 'MEMORY',
    FILESYSTEM: 'FILESYSTEM',
    CONTROL_ORG: 'CONTROL_ORG'
});

const DURABLE_STORAGE_UNAVAILABLE_MESSAGE =
    'Destination snapshot capture failed: durable snapshot storage is not configured.';

function resolveSnapshotStorageConfig(env = process.env) {
    const rawMode = String(env[STORAGE_MODE_ENV] || STORAGE_MODE.MEMORY)
        .trim()
        .toUpperCase();
    const rootDir = String(env[DURABLE_ROOT_ENV] || '').trim();

    if (rawMode === STORAGE_MODE.CONTROL_ORG) {
        return {
            storageMode: STORAGE_MODE.CONTROL_ORG,
            rootDir: rootDir || null,
            backend: STORAGE_BACKEND.CONTROL_ORG,
            configured: true
        };
    }

    const storageMode =
        rawMode === STORAGE_MODE.DURABLE
            ? STORAGE_MODE.DURABLE
            : STORAGE_MODE.MEMORY;

    return {
        storageMode,
        rootDir: rootDir || null,
        backend:
            storageMode === STORAGE_MODE.DURABLE
                ? STORAGE_BACKEND.FILESYSTEM
                : STORAGE_BACKEND.MEMORY,
        configured:
            storageMode !== STORAGE_MODE.DURABLE || Boolean(rootDir)
    };
}

function isDurableSnapshotStorageReady(env = process.env) {
    const config = resolveSnapshotStorageConfig(env);

    return (
        config.storageMode === STORAGE_MODE.DURABLE &&
        Boolean(config.rootDir)
    );
}

function shouldUseDurableSnapshotStorage(env = process.env) {
    return isDurableSnapshotStorageReady(env);
}

module.exports = {
    STORAGE_MODE_ENV,
    DURABLE_ROOT_ENV,
    STORAGE_BACKEND,
    DURABLE_STORAGE_UNAVAILABLE_MESSAGE,
    resolveSnapshotStorageConfig,
    isDurableSnapshotStorageReady,
    shouldUseDurableSnapshotStorage,
    parseEnvBool
};
