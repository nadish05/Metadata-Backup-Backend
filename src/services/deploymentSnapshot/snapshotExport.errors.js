'use strict';

const SNAPSHOT_EXPORT_ERROR_CODE = Object.freeze({
    INVALID_REQUEST: 'SNAPSHOT_EXPORT_INVALID_REQUEST',
    NOT_FOUND: 'SNAPSHOT_EXPORT_NOT_FOUND',
    ARTIFACT_NOT_FOUND: 'SNAPSHOT_ARTIFACT_NOT_FOUND',
    SNAPSHOT_UNAVAILABLE: 'SNAPSHOT_EXPORT_UNAVAILABLE'
});

class SnapshotExportError extends Error {
    constructor(code, message, extras = {}) {
        super(message);
        this.name = 'SnapshotExportError';
        this.code = code;
        Object.assign(this, extras);
    }
}

module.exports = {
    SNAPSHOT_EXPORT_ERROR_CODE,
    SnapshotExportError
};
