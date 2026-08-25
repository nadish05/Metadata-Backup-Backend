'use strict';

const {
    LOCK_STORE_BACKEND,
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_LEASE_MS,
    LOCK_PRODUCTION_DISTRIBUTED_READY
} = require('./deploymentOrgLock.types');
const {
    STORE_ENV,
    ROOT_ENV,
    HEARTBEAT_MS_ENV,
    LEASE_MS_ENV,
    isDeploymentOrgLockEnabled,
    resolveLockStoreName,
    resolveLockRoot,
    parsePositiveInt
} = require('./deploymentOrgLock.flag');
const { createOrgLockService } = require('./deploymentOrgLock.service');
const { createFileOrgLockStore } = require('./stores/fileOrgLockStore');
const {
    createUnavailableOrgLockStore
} = require('./stores/unavailableOrgLockStore');

const UNCONFIGURED_MESSAGE =
    'Destination org lock store is not configured. Set DEPLOYMENT_LOCK_STORE=FILESYSTEM and DEPLOYMENT_LOCK_ROOT.';

let cachedKey = null;
let cachedService = null;

function resolveLockConfig(env = process.env) {
    const storeName = resolveLockStoreName(env);
    const rootDir = resolveLockRoot(env);
    const heartbeatMs = parsePositiveInt(
        env[HEARTBEAT_MS_ENV],
        DEFAULT_HEARTBEAT_MS
    );
    const leaseMs = parsePositiveInt(env[LEASE_MS_ENV], DEFAULT_LEASE_MS);
    const filesystemReady =
        storeName === LOCK_STORE_BACKEND.FILESYSTEM && Boolean(rootDir);

    return {
        storeName: storeName || LOCK_STORE_BACKEND.UNCONFIGURED,
        rootDir,
        heartbeatMs,
        leaseMs,
        filesystemReady,
        productionDistributedReady: LOCK_PRODUCTION_DISTRIBUTED_READY
    };
}

function isApprovedLockStoreReady(env = process.env) {
    return resolveLockConfig(env).filesystemReady === true;
}

function createStoreForConfig(config) {
    if (config.filesystemReady) {
        return createFileOrgLockStore({ rootDir: config.rootDir });
    }

    return createUnavailableOrgLockStore(UNCONFIGURED_MESSAGE);
}

function getSharedOrgLockService(env = process.env) {
    const config = resolveLockConfig(env);
    const key = `${config.storeName}:${config.rootDir || ''}:${config.leaseMs}`;

    if (cachedService && cachedKey === key) {
        return cachedService;
    }

    cachedService = createOrgLockService({
        store: createStoreForConfig(config),
        leaseMs: config.leaseMs
    });
    cachedKey = key;

    return cachedService;
}

function resetSharedOrgLockServiceForTests() {
    cachedKey = null;
    cachedService = null;
}

module.exports = {
    STORE_ENV,
    ROOT_ENV,
    UNCONFIGURED_MESSAGE,
    resolveLockConfig,
    isApprovedLockStoreReady,
    isDeploymentOrgLockEnabled,
    getSharedOrgLockService,
    resetSharedOrgLockServiceForTests
};
