'use strict';

const {
    SNAPSHOT_STATUS
} = require('../snapshot.types');
const {
    SnapshotAlreadySealedError,
    SnapshotNotFoundError,
    SnapshotStateError
} = require('../snapshot.errors');
const { memberIdentityKey } = require('../snapshot.types');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createMemorySnapshotMetadataStore() {
    const snapshots = new Map();
    const membersBySnapshot = new Map();

    function requireSnapshot(snapshotId) {
        const snapshot = snapshots.get(snapshotId);

        if (!snapshot) {
            throw new SnapshotNotFoundError(snapshotId);
        }

        return snapshot;
    }

    function assertMutable(snapshot) {
        if (snapshot.status === SNAPSHOT_STATUS.SEALED) {
            throw new SnapshotAlreadySealedError(snapshot.snapshotId);
        }
    }

    async function createSnapshot(snapshot) {
        if (!snapshot?.snapshotId) {
            throw new SnapshotStateError('snapshotId is required.');
        }

        if (snapshots.has(snapshot.snapshotId)) {
            throw new SnapshotStateError(
                `Snapshot already exists: ${snapshot.snapshotId}`
            );
        }

        const stored = clone(snapshot);
        snapshots.set(stored.snapshotId, stored);
        membersBySnapshot.set(stored.snapshotId, new Map());

        return clone(stored);
    }

    async function getSnapshot(snapshotId) {
        const snapshot = snapshots.get(snapshotId);

        return snapshot ? clone(snapshot) : null;
    }

    async function updateSnapshot(snapshotId, patch) {
        const snapshot = requireSnapshot(snapshotId);
        assertMutable(snapshot);

        Object.assign(snapshot, patch);

        return clone(snapshot);
    }

    async function addMember(member) {
        const snapshot = requireSnapshot(member.snapshotId);
        assertMutable(snapshot);

        const members = membersBySnapshot.get(member.snapshotId);
        const key = memberIdentityKey(
            member.metadataType,
            member.metadataName
        );
        members.set(key, clone(member));

        return clone(member);
    }

    async function getMember(snapshotId, metadataType, metadataName) {
        requireSnapshot(snapshotId);
        const members = membersBySnapshot.get(snapshotId);
        const stored = members.get(
            memberIdentityKey(metadataType, metadataName)
        );

        return stored ? clone(stored) : null;
    }

    async function getMembers(snapshotId) {
        requireSnapshot(snapshotId);
        const members = membersBySnapshot.get(snapshotId);

        return [...members.values()].map(clone);
    }

    async function sealSnapshot(snapshotId, sealFields = {}) {
        const snapshot = requireSnapshot(snapshotId);
        assertMutable(snapshot);

        Object.assign(snapshot, sealFields, {
            status: SNAPSHOT_STATUS.SEALED
        });

        return clone(snapshot);
    }

    return {
        createSnapshot,
        getSnapshot,
        updateSnapshot,
        addMember,
        getMember,
        getMembers,
        sealSnapshot
    };
}

module.exports = {
    createMemorySnapshotMetadataStore
};
