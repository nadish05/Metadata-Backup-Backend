'use strict';

/**
 * SnapshotBlobStore contract (storage-provider independent).
 *
 * Azure Blob Storage can implement this interface later without changing
 * snapshot business logic. Artifacts are exact destination-before bytes.
 *
 * Required async methods:
 *   putArtifact({ artifactId, bytes }) → { artifactId, size }
 *   getArtifact(artifactId) → Buffer | null
 *   exists(artifactId) → boolean
 *   getMetadata(artifactId) → { artifactId, size } | null
 */

const BLOB_STORE_METHODS = Object.freeze([
    'putArtifact',
    'getArtifact',
    'exists',
    'getMetadata'
]);

function assertBlobStore(store) {
    if (!store || typeof store !== 'object') {
        throw new TypeError('SnapshotBlobStore is required.');
    }

    for (const method of BLOB_STORE_METHODS) {
        if (typeof store[method] !== 'function') {
            throw new TypeError(
                `SnapshotBlobStore is missing method: ${method}`
            );
        }
    }
}

module.exports = {
    BLOB_STORE_METHODS,
    assertBlobStore
};
