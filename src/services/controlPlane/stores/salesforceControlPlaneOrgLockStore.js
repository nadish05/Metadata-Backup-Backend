'use strict';

const {
    OrgLockBusyError,
    OrgLockOwnershipError,
    OrgLockStoreUnavailableError
} = require('../../deploymentOrgLock/deploymentOrgLock.errors');
const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('../controlPlane.errors');
const { createAuthUnavailableError } = require('../controlPlane.auth');
const { MISSING_CONTROL_PLANE_ENDPOINTS } = require('../controlPlane.missingEndpoints');
const {
    fromSalesforceLock,
    toSalesforceLockAcquirePayload,
    toSalesforceLockOwnershipPayload
} = require('../controlPlane.lockMapping');

function resolveClient(options = {}) {
    if (options.client) {
        return options.client;
    }

    if (typeof options.getClient === 'function') {
        return options.getClient();
    }

    throw createAuthUnavailableError();
}

function encodePath(value) {
    return encodeURIComponent(String(value));
}

function mapLockError(error, destinationOrgId) {
    if (error instanceof ControlPlaneError) {
        if (error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE) {
            return error;
        }

        if (error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND) {
            return error;
        }

        if (error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT) {
            const message = String(error.message || '');

            if (
                /generation/i.test(message) ||
                /owner/i.test(message)
            ) {
                return new OrgLockOwnershipError();
            }

            return new OrgLockBusyError(destinationOrgId);
        }
    }

    return error;
}

function createSalesforceControlPlaneOrgLockStore(options = {}) {
    async function acquire(args = {}) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane('POST', '/locks/acquire', {
                body: toSalesforceLockAcquirePayload(args)
            });

            return fromSalesforceLock(envelope.record, envelope.leaseGeneration);
        } catch (error) {
            throw mapLockError(error, args.destinationOrgId);
        }
    }

    async function renew(args = {}) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane('POST', '/locks/renew', {
                body: toSalesforceLockOwnershipPayload(args)
            });

            return fromSalesforceLock(envelope.record, envelope.leaseGeneration);
        } catch (error) {
            throw mapLockError(error, args.destinationOrgId);
        }
    }

    async function release(args = {}) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane('POST', '/locks/release', {
                body: toSalesforceLockOwnershipPayload(args)
            });

            return fromSalesforceLock(envelope.record, envelope.leaseGeneration);
        } catch (error) {
            throw mapLockError(error, args.destinationOrgId);
        }
    }

    async function get(args = {}) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'GET',
                `/locks/${encodePath(args.destinationOrgId)}`
            );

            return fromSalesforceLock(envelope.record, envelope.leaseGeneration);
        } catch (error) {
            if (
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
            ) {
                return null;
            }

            throw mapLockError(error, args.destinationOrgId);
        }
    }

    async function adminRelease() {
        resolveClient(options);
        throw new OrgLockStoreUnavailableError(
            MISSING_CONTROL_PLANE_ENDPOINTS.lockAdminRelease
        );
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
    createSalesforceControlPlaneOrgLockStore
};
