'use strict';

const { CONTROL_PLANE_ERROR_CODE, ControlPlaneError } = require('../controlPlane.errors');
const { createAuthUnavailableError } = require('../controlPlane.auth');
const {
    assertSafeControlPlaneArtifactId,
    encodeControlPlaneArtifactPath
} = require('../controlPlane.artifactId');

function resolveClient(options = {}) {
    if (options.client) {
        return options.client;
    }

    if (typeof options.getClient === 'function') {
        return options.getClient();
    }

    throw createAuthUnavailableError();
}

function toStoredBuffer(bytes) {
    if (Buffer.isBuffer(bytes)) {
        return bytes;
    }

    if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes);
    }

    throw new TypeError('Artifact bytes must be a Buffer or Uint8Array.');
}

function createSalesforceControlPlaneSnapshotBlobStore(options = {}) {
    async function putArtifact({ artifactId, bytes } = {}) {
        const identity = assertSafeControlPlaneArtifactId(artifactId);
        const stored = toStoredBuffer(bytes);

        if (stored.length === 0) {
            throw new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
                'Artifact bytes are required.'
            );
        }

        const client = resolveClient(options);
        const envelope = await client.controlPlane(
            'POST',
            `/snapshots/${encodeURIComponent(identity.snapshotId)}/artifacts`,
            {
                body: stored,
                query: { artifactId: identity.artifactId },
                contentType: 'application/octet-stream',
                headers: {
                    'X-Control-Plane-Artifact-Id': identity.artifactId
                }
            }
        );

        const size =
            envelope.size == null ? stored.length : Number(envelope.size);

        return {
            artifactId: envelope.artifactId || identity.artifactId,
            size
        };
    }

    async function getArtifact(artifactId) {
        const identity = assertSafeControlPlaneArtifactId(artifactId);
        const client = resolveClient(options);

        try {
            const bytes = await client.controlPlaneBinary(
                'GET',
                encodeControlPlaneArtifactPath(identity)
            );

            return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        } catch (error) {
            if (
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
            ) {
                return null;
            }

            throw error;
        }
    }

    async function exists(artifactId) {
        const identity = assertSafeControlPlaneArtifactId(artifactId);
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'GET',
                `${encodeControlPlaneArtifactPath(identity)}/exists`
            );

            return envelope.exists === true;
        } catch (error) {
            if (
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
            ) {
                return false;
            }

            throw error;
        }
    }

    async function getMetadata(artifactId) {
        const identity = assertSafeControlPlaneArtifactId(artifactId);
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'GET',
                `${encodeControlPlaneArtifactPath(identity)}/metadata`
            );

            return {
                artifactId: envelope.artifactId || identity.artifactId,
                size: Number(envelope.size)
            };
        } catch (error) {
            if (
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
            ) {
                return null;
            }

            throw error;
        }
    }

    return {
        putArtifact,
        getArtifact,
        exists,
        getMetadata
    };
}

module.exports = {
    createSalesforceControlPlaneSnapshotBlobStore
};
