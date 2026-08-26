'use strict';

const { createSnapshotCaptureService } = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    createFileSnapshotStores
} = require('./stores/fileSnapshotStores');
const {
    STORAGE_MODE,
    buildSnapshotStorageCapability,
    DURABLE_UNCONFIGURED_SNAPSHOT_STORAGE_CAPABILITY
} = require('./snapshotStorageCapability');
const {
    resolveSnapshotStorageConfig,
    isDurableSnapshotStorageReady,
    DURABLE_STORAGE_UNAVAILABLE_MESSAGE
} = require('./snapshotStorage.config');
const {
    createSalesforceControlPlaneSnapshotMetadataStore
} = require('../controlPlane/stores/salesforceControlPlaneSnapshotMetadataStore');
const {
    createSalesforceControlPlaneSnapshotBlobStore
} = require('../controlPlane/stores/salesforceControlPlaneSnapshotBlobStore');
const { getSharedControlPlaneClient } = require('../controlPlane/controlPlane.runtime');

let cachedKey = null;
let cachedAccess = null;

function buildMemoryAccess() {
    const metadataStore = createMemorySnapshotMetadataStore();
    const blobStore = createMemorySnapshotBlobStore();
    const captureService = createSnapshotCaptureService({
        metadataStore,
        blobStore
    });

    return wrapAccess({
        captureService,
        capability: buildSnapshotStorageCapability({
            storageMode: STORAGE_MODE.MEMORY
        })
    });
}

function buildUnconfiguredDurableAccess() {
    const fail = async () => {
        throw new Error(DURABLE_STORAGE_UNAVAILABLE_MESSAGE);
    };

    const captureService = {
        captureSnapshot: fail,
        sealSnapshot: fail,
        getSnapshot: fail,
        getMembers: fail,
        getArtifact: fail,
        verifySnapshotIntegrity: fail
    };

    return wrapAccess({
        captureService,
        capability: { ...DURABLE_UNCONFIGURED_SNAPSHOT_STORAGE_CAPABILITY }
    });
}

function buildDurableAccess(rootDir) {
    const { metadataStore, blobStore } = createFileSnapshotStores({
        rootDir
    });
    const captureService = createSnapshotCaptureService({
        metadataStore,
        blobStore
    });

    return wrapAccess({
        captureService,
        capability: buildSnapshotStorageCapability({
            storageMode: STORAGE_MODE.DURABLE,
            rootDir
        })
    });
}

function buildControlOrgAccess() {
    const getClient = () => getSharedControlPlaneClient();
    const metadataStore = createSalesforceControlPlaneSnapshotMetadataStore({
        getClient
    });
    const blobStore = createSalesforceControlPlaneSnapshotBlobStore({
        getClient
    });
    const captureService = createSnapshotCaptureService({
        metadataStore,
        blobStore
    });

    return wrapAccess({
        captureService,
        capability: buildSnapshotStorageCapability({
            storageMode: STORAGE_MODE.CONTROL_ORG
        })
    });
}

function wrapAccess({ captureService, capability }) {
    return Object.freeze({
        captureService,
        getSnapshot: (snapshotId) => captureService.getSnapshot(snapshotId),
        getMembers: (snapshotId) => captureService.getMembers(snapshotId),
        getArtifact: (snapshotId, artifactId) =>
            captureService.getArtifact(snapshotId, artifactId),
        verifySnapshotIntegrity: (snapshotId) =>
            captureService.verifySnapshotIntegrity(snapshotId),
        getStorageCapability: () => ({ ...capability })
    });
}

function cacheKey(config) {
    return `${config.storageMode}:${config.rootDir || ''}`;
}

function getSharedSnapshotAccess() {
    const config = resolveSnapshotStorageConfig();
    const key = cacheKey(config);

    if (cachedAccess && cachedKey === key) {
        return cachedAccess;
    }

    if (config.storageMode === STORAGE_MODE.CONTROL_ORG) {
        cachedAccess = buildControlOrgAccess();
    } else if (config.storageMode === STORAGE_MODE.DURABLE && config.rootDir) {
        cachedAccess = buildDurableAccess(config.rootDir);
    } else if (config.storageMode === STORAGE_MODE.DURABLE) {
        cachedAccess = buildUnconfiguredDurableAccess();
    } else {
        cachedAccess = buildMemoryAccess();
    }

    cachedKey = key;

    return cachedAccess;
}

function resetSharedSnapshotAccessForTests() {
    cachedKey = null;
    cachedAccess = null;
}

module.exports = {
    getSharedSnapshotAccess,
    isDurableSnapshotStorageReady,
    resetSharedSnapshotAccessForTests
};
