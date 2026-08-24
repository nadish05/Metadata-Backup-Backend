'use strict';

/**
 * Deployment Snapshot domain constants (P0-R2).
 *
 * Isolated rollback-foundation types. Not consumed by the deployment engine.
 */

const SCHEMA_VERSION = 1;
const SNAPSHOT_VERSION = 1;

const SNAPSHOT_STATUS = Object.freeze({
    CAPTURING: 'CAPTURING',
    READY: 'READY',
    SEALED: 'SEALED',
    FAILED: 'FAILED'
});

const CHANGE_CLASS = Object.freeze({
    MODIFIED: 'MODIFIED',
    NEW: 'NEW',
    UNKNOWN: 'UNKNOWN'
});

const MEMBER_CAPTURE_STATUS = Object.freeze({
    COMPLETE: 'COMPLETE',
    ABSENT_PROVEN: 'ABSENT_PROVEN',
    UNKNOWN: 'UNKNOWN',
    FAILED: 'FAILED'
});

const TERMINAL_SNAPSHOT_STATUSES = Object.freeze([
    SNAPSHOT_STATUS.SEALED,
    SNAPSHOT_STATUS.FAILED
]);

function memberIdentityKey(metadataType, metadataName) {
    return `${metadataType}:${metadataName}`;
}

module.exports = {
    SCHEMA_VERSION,
    SNAPSHOT_VERSION,
    SNAPSHOT_STATUS,
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    TERMINAL_SNAPSHOT_STATUSES,
    memberIdentityKey
};
