'use strict';

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');

function assertSafeControlPlaneArtifactId(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'artifactId is required.'
        );
    }

    const posix = artifactId.replace(/\\/g, '/');

    if (
        posix.includes('..') ||
        posix.startsWith('/') ||
        !posix.startsWith('snapshots/')
    ) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'artifactId must be a snapshots/ relative path.'
        );
    }

    const parts = posix.split('/');

    if (
        parts.length !== 5 ||
        parts[0] !== 'snapshots' ||
        parts[2] !== 'destination-before' ||
        !parts[1] ||
        !parts[3] ||
        !parts[4]
    ) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'artifactId must match snapshots/{snapshotId}/destination-before/{type}/{name}.'
        );
    }

    return {
        artifactId: posix,
        snapshotId: parts[1],
        metadataType: decodeURIComponent(parts[3]),
        metadataName: decodeURIComponent(parts[4])
    };
}

function encodeControlPlaneArtifactPath(identity) {
    return (
        `/snapshots/${encodeURIComponent(identity.snapshotId)}` +
        `/artifacts/${encodeURIComponent(identity.artifactId)}`
    );
}

module.exports = {
    assertSafeControlPlaneArtifactId,
    encodeControlPlaneArtifactPath
};
