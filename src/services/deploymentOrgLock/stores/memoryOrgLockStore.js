'use strict';

const crypto = require('crypto');

const { LOCK_STATUS } = require('../deploymentOrgLock.types');
const {
    OrgLockBusyError,
    OrgLockOwnershipError
} = require('../deploymentOrgLock.errors');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createMemoryOrgLockStore({ now = () => Date.now() } = {}) {
    const records = new Map();

    function getHeld(destinationOrgId) {
        const record = records.get(destinationOrgId);

        if (!record || record.status !== LOCK_STATUS.HELD) {
            return null;
        }

        return record;
    }

    function acquire({
        destinationOrgId,
        ownerId,
        operationType,
        historyId = null,
        snapshotId = null
    }) {
        const held = getHeld(destinationOrgId);

        if (held) {
            throw new OrgLockBusyError(destinationOrgId);
        }

        const previous = records.get(destinationOrgId);
        const leaseGeneration = (previous?.leaseGeneration || 0) + 1;
        const timestamp = new Date(now()).toISOString();
        const record = {
            lockId: `lock_${crypto.randomUUID()}`,
            destinationOrgId,
            ownerId,
            operationType,
            leaseGeneration,
            acquiredAt: timestamp,
            expiresAt: timestamp,
            lastHeartbeatAt: timestamp,
            historyId: historyId || null,
            snapshotId: snapshotId || null,
            releasedAt: null,
            status: LOCK_STATUS.HELD
        };

        records.set(destinationOrgId, clone(record));

        return clone(record);
    }

    function get({ destinationOrgId }) {
        const record = records.get(destinationOrgId);

        return record ? clone(record) : null;
    }

    function assertOwner(record, ownerId, leaseGeneration) {
        if (
            !record ||
            record.status !== LOCK_STATUS.HELD ||
            record.ownerId !== ownerId ||
            record.leaseGeneration !== leaseGeneration
        ) {
            throw new OrgLockOwnershipError();
        }
    }

    function renew({ destinationOrgId, ownerId, leaseGeneration, expiresAt }) {
        const record = getHeld(destinationOrgId);
        assertOwner(record, ownerId, leaseGeneration);
        record.lastHeartbeatAt = new Date(now()).toISOString();
        record.expiresAt = expiresAt || record.lastHeartbeatAt;
        records.set(destinationOrgId, clone(record));

        return clone(record);
    }

    function release({ destinationOrgId, ownerId, leaseGeneration }) {
        const record = records.get(destinationOrgId);

        if (!record || record.status === LOCK_STATUS.RELEASED) {
            if (
                record &&
                record.ownerId === ownerId &&
                record.leaseGeneration === leaseGeneration
            ) {
                return clone(record);
            }

            if (!record) {
                return null;
            }

            throw new OrgLockOwnershipError();
        }

        assertOwner(record, ownerId, leaseGeneration);
        record.status = LOCK_STATUS.RELEASED;
        record.releasedAt = new Date(now()).toISOString();
        records.set(destinationOrgId, clone(record));

        return clone(record);
    }

    function adminRelease({ destinationOrgId, reason, actor }) {
        const record = records.get(destinationOrgId);

        if (!record) {
            return null;
        }

        record.status = LOCK_STATUS.RELEASED;
        record.releasedAt = new Date(now()).toISOString();
        record.adminRelease = { reason: reason || null, actor: actor || null };
        records.set(destinationOrgId, clone(record));

        return clone(record);
    }

    return {
        acquire,
        renew,
        release,
        get,
        adminRelease
    };
}

module.exports = {
    createMemoryOrgLockStore
};
