'use strict';

function toBuffer(bytes) {
    if (Buffer.isBuffer(bytes)) {
        return Buffer.from(bytes);
    }

    if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes);
    }

    throw new TypeError('Artifact bytes must be a Buffer or Uint8Array.');
}

function createMemorySnapshotBlobStore() {
    const artifacts = new Map();

    async function putArtifact({ artifactId, bytes }) {
        if (!artifactId) {
            throw new TypeError('artifactId is required.');
        }

        const stored = toBuffer(bytes);
        artifacts.set(artifactId, stored);

        return {
            artifactId,
            size: stored.length
        };
    }

    async function getArtifact(artifactId) {
        const stored = artifacts.get(artifactId);

        return stored ? Buffer.from(stored) : null;
    }

    async function exists(artifactId) {
        return artifacts.has(artifactId);
    }

    async function getMetadata(artifactId) {
        const stored = artifacts.get(artifactId);

        if (!stored) {
            return null;
        }

        return {
            artifactId,
            size: stored.length
        };
    }

    /**
     * Test-only helper: replace stored bytes without changing artifactId.
     * Not part of SnapshotBlobStore. Used to simulate corruption.
     */
    async function replaceArtifactBytes(artifactId, bytes) {
        if (!artifacts.has(artifactId)) {
            throw new Error(`Artifact not found: ${artifactId}`);
        }

        artifacts.set(artifactId, toBuffer(bytes));
    }

    return {
        putArtifact,
        getArtifact,
        exists,
        getMetadata,
        replaceArtifactBytes
    };
}

module.exports = {
    createMemorySnapshotBlobStore
};
