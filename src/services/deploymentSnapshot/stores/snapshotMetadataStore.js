'use strict';

/**
 * SnapshotMetadataStore contract (storage-provider independent).
 *
 * Azure SQL (or any durable index) can implement this interface later without
 * changing snapshot business logic.
 *
 * Required async methods:
 *   createSnapshot(snapshot) → snapshot
 *   getSnapshot(snapshotId) → snapshot | null
 *   updateSnapshot(snapshotId, patch) → snapshot
 *   addMember(member) → member
 *   getMember(snapshotId, metadataType, metadataName) → member | null
 *   getMembers(snapshotId) → member[]
 *   sealSnapshot(snapshotId, sealFields) → snapshot
 *
 * Implementations MUST reject mutations of SEALED snapshots.
 */

const METADATA_STORE_METHODS = Object.freeze([
    'createSnapshot',
    'getSnapshot',
    'updateSnapshot',
    'addMember',
    'getMember',
    'getMembers',
    'sealSnapshot'
]);

function assertMetadataStore(store) {
    if (!store || typeof store !== 'object') {
        throw new TypeError('SnapshotMetadataStore is required.');
    }

    for (const method of METADATA_STORE_METHODS) {
        if (typeof store[method] !== 'function') {
            throw new TypeError(
                `SnapshotMetadataStore is missing method: ${method}`
            );
        }
    }
}

module.exports = {
    METADATA_STORE_METHODS,
    assertMetadataStore
};
