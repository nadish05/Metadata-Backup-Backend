'use strict';

const {
    SNAPSHOT_EXPORT_ERROR_CODE,
    SnapshotExportError
} = require('./snapshotExport.errors');

function assertSafeSnapshotArtifactId(artifactId, expectedSnapshotId = null) {
    if (!artifactId || typeof artifactId !== 'string') {
        throw new SnapshotExportError(
            SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST,
            'artifactId is required.'
        );
    }

    const posix = artifactId.replace(/\\/g, '/');

    if (
        posix.includes('..') ||
        posix.startsWith('/') ||
        !posix.startsWith('snapshots/')
    ) {
        throw new SnapshotExportError(
            SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST,
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
        throw new SnapshotExportError(
            SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST,
            'artifactId must match snapshots/{snapshotId}/destination-before/{type}/{name}.'
        );
    }

    if (
        expectedSnapshotId &&
        parts[1] !== String(expectedSnapshotId).trim()
    ) {
        throw new SnapshotExportError(
            SNAPSHOT_EXPORT_ERROR_CODE.ARTIFACT_NOT_FOUND,
            'Artifact does not belong to this snapshot.'
        );
    }

    return {
        artifactId: posix,
        snapshotId: parts[1],
        metadataType: decodeURIComponent(parts[3]),
        metadataName: decodeURIComponent(parts[4])
    };
}

module.exports = {
    assertSafeSnapshotArtifactId
};
