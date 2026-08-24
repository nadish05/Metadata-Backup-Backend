'use strict';

const { createSnapshotCaptureService } = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    MEMORY_SNAPSHOT_STORAGE_CAPABILITY
} = require('./snapshotStorageCapability');

const sharedMetadataStore = createMemorySnapshotMetadataStore();
const sharedBlobStore = createMemorySnapshotBlobStore();
const sharedCaptureService = createSnapshotCaptureService({
    metadataStore: sharedMetadataStore,
    blobStore: sharedBlobStore
});

const sharedSnapshotAccess = Object.freeze({
    captureService: sharedCaptureService,
    getSnapshot: (snapshotId) => sharedCaptureService.getSnapshot(snapshotId),
    getMembers: (snapshotId) => sharedCaptureService.getMembers(snapshotId),
    getArtifact: (snapshotId, artifactId) =>
        sharedCaptureService.getArtifact(snapshotId, artifactId),
    verifySnapshotIntegrity: (snapshotId) =>
        sharedCaptureService.verifySnapshotIntegrity(snapshotId),
    getStorageCapability: () => ({ ...MEMORY_SNAPSHOT_STORAGE_CAPABILITY })
});

function getSharedSnapshotAccess() {
    return sharedSnapshotAccess;
}

module.exports = {
    getSharedSnapshotAccess
};
