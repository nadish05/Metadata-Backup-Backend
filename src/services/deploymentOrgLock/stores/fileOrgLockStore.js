'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    assertSafeStorageKey,
    pathExistsSync,
    atomicWriteSync
} = require('../../../utils/durableFileStore');
const { LOCK_STATUS } = require('../deploymentOrgLock.types');
const {
    OrgLockBusyError,
    OrgLockOwnershipError,
    OrgLockStoreUnavailableError
} = require('../deploymentOrgLock.errors');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createFileOrgLockStore({ rootDir, now = () => Date.now() } = {}) {
    if (!rootDir) {
        throw new OrgLockStoreUnavailableError(
            'DEPLOYMENT_LOCK_ROOT is required for filesystem org lock storage.'
        );
    }

    const locksRoot = path.join(rootDir, 'org-locks');

    function recordFile(destinationOrgId) {
        assertSafeStorageKey(destinationOrgId, 'destinationOrgId');

        return path.join(locksRoot, `${destinationOrgId}.json`);
    }

    function heldFile(destinationOrgId) {
        return `${recordFile(destinationOrgId)}.held`;
    }

    function readRecord(destinationOrgId) {
        const filePath = recordFile(destinationOrgId);

        if (!pathExistsSync(filePath)) {
            return null;
        }

        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            throw new OrgLockStoreUnavailableError(
                'Org lock record is unreadable.'
            );
        }
    }

    function writeRecord(destinationOrgId, record) {
        atomicWriteSync(
            recordFile(destinationOrgId),
            JSON.stringify(record, null, 2)
        );
    }

    function acquire({
        destinationOrgId,
        ownerId,
        operationType,
        historyId = null,
        snapshotId = null
    }) {
        const filePath = recordFile(destinationOrgId);
        const tokenPath = heldFile(destinationOrgId);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        try {
            fs.writeFileSync(tokenPath, ownerId, { flag: 'wx' });
        } catch (error) {
            if (error && error.code === 'EEXIST') {
                throw new OrgLockBusyError(destinationOrgId);
            }

            throw error;
        }

        const previous = readRecord(destinationOrgId);

        if (previous?.status === LOCK_STATUS.HELD) {
            try {
                fs.unlinkSync(tokenPath);
            } catch (cleanupError) {
                void cleanupError;
            }

            throw new OrgLockBusyError(destinationOrgId);
        }

        const timestamp = new Date(now()).toISOString();
        const record = {
            lockId: `lock_${crypto.randomUUID()}`,
            destinationOrgId,
            ownerId,
            operationType,
            leaseGeneration: (previous?.leaseGeneration || 0) + 1,
            acquiredAt: timestamp,
            expiresAt: timestamp,
            lastHeartbeatAt: timestamp,
            historyId: historyId || null,
            snapshotId: snapshotId || null,
            releasedAt: null,
            status: LOCK_STATUS.HELD
        };

        writeRecord(destinationOrgId, record);

        return clone(record);
    }

    function get({ destinationOrgId }) {
        const record = readRecord(destinationOrgId);

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
        const record = readRecord(destinationOrgId);
        assertOwner(record, ownerId, leaseGeneration);
        record.lastHeartbeatAt = new Date(now()).toISOString();
        record.expiresAt = expiresAt || record.lastHeartbeatAt;
        writeRecord(destinationOrgId, record);

        return clone(record);
    }

    function release({ destinationOrgId, ownerId, leaseGeneration }) {
        const record = readRecord(destinationOrgId);

        if (!record) {
            return null;
        }

        if (record.status === LOCK_STATUS.RELEASED) {
            if (
                record.ownerId === ownerId &&
                record.leaseGeneration === leaseGeneration
            ) {
                return clone(record);
            }

            throw new OrgLockOwnershipError();
        }

        assertOwner(record, ownerId, leaseGeneration);
        record.status = LOCK_STATUS.RELEASED;
        record.releasedAt = new Date(now()).toISOString();
        writeRecord(destinationOrgId, record);

        try {
            if (pathExistsSync(heldFile(destinationOrgId))) {
                fs.unlinkSync(heldFile(destinationOrgId));
            }
        } catch (error) {
            void error;
        }

        return clone(record);
    }

    function adminRelease({ destinationOrgId, reason, actor }) {
        const record = readRecord(destinationOrgId) || {
            lockId: null,
            destinationOrgId,
            ownerId: null,
            operationType: null,
            leaseGeneration: 0,
            acquiredAt: null,
            expiresAt: null,
            lastHeartbeatAt: null,
            historyId: null,
            snapshotId: null,
            status: LOCK_STATUS.RELEASED
        };

        record.status = LOCK_STATUS.RELEASED;
        record.releasedAt = new Date(now()).toISOString();
        record.adminRelease = { reason: reason || null, actor: actor || null };
        writeRecord(destinationOrgId, record);

        try {
            if (pathExistsSync(heldFile(destinationOrgId))) {
                fs.unlinkSync(heldFile(destinationOrgId));
            }
        } catch (error) {
            void error;
        }

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
    createFileOrgLockStore
};
