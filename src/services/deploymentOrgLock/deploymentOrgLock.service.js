'use strict';

const crypto = require('crypto');

const { LOCK_STATUS, DEFAULT_LEASE_MS } = require('./deploymentOrgLock.types');
const {
    OrgLockFenceError,
    OrgLockOwnershipError
} = require('./deploymentOrgLock.errors');
const { logLockEvent } = require('./deploymentOrgLock.log');

const runtimeId = `runtime_${crypto.randomUUID()}`;

function createOwnerId() {
    return `${runtimeId}:worker_${crypto.randomUUID()}`;
}

function createOrgLockService({
    store,
    now = () => Date.now(),
    leaseMs = DEFAULT_LEASE_MS
} = {}) {
    if (!store) {
        throw new Error('Org lock store is required.');
    }

    function withExpiry(record) {
        const expiresAt = new Date(now() + leaseMs).toISOString();

        return { ...record, expiresAt };
    }

    function acquire(args) {
        logLockEvent('LOCK_ACQUIRE_REQUESTED', args);

        const record = store.acquire(args);
        const held = withExpiry(record);
        const renewed = store.renew({
            destinationOrgId: held.destinationOrgId,
            ownerId: held.ownerId,
            leaseGeneration: held.leaseGeneration,
            expiresAt: held.expiresAt
        });

        logLockEvent('LOCK_ACQUIRED', renewed);

        return renewed;
    }

    function renew(args) {
        const expiresAt = new Date(now() + leaseMs).toISOString();
        const renewed = store.renew({ ...args, expiresAt });
        logLockEvent('LOCK_RENEWED', renewed);

        return renewed;
    }

    function release(args) {
        try {
            const released = store.release(args);
            logLockEvent('LOCK_RELEASED', {
                ...(released || args)
            });

            return released;
        } catch (error) {
            logLockEvent('LOCK_RELEASE_FAILED', args);
            throw error;
        }
    }

    function get(args) {
        return store.get(args);
    }

    function adminRelease(args) {
        logLockEvent('LOCK_RECOVERY_REQUIRED', args);
        const released = store.adminRelease(args);
        logLockEvent('LOCK_RELEASED', {
            ...(released || args),
            actor: args.actor,
            reason: args.reason
        });

        return released;
    }

    function assertHeld({ destinationOrgId, ownerId, leaseGeneration }) {
        const current = store.get({ destinationOrgId });

        if (
            !current ||
            current.status !== LOCK_STATUS.HELD ||
            current.ownerId !== ownerId ||
            current.leaseGeneration !== leaseGeneration
        ) {
            throw new OrgLockFenceError();
        }

        return current;
    }

    return {
        acquire,
        renew,
        release,
        get,
        adminRelease,
        assertHeld,
        createOwnerId
    };
}

module.exports = {
    createOrgLockService,
    createOwnerId,
    runtimeId,
    OrgLockOwnershipError
};
