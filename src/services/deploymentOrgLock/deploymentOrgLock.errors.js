'use strict';

class OrgLockError extends Error {
    constructor(message, code = 'ORG_LOCK_ERROR') {
        super(message);
        this.name = 'OrgLockError';
        this.code = code;
    }
}

class OrgLockBusyError extends OrgLockError {
    constructor(destinationOrgId) {
        super(
            `Destination org is already locked: ${destinationOrgId}`,
            'LOCK_BUSY'
        );
        this.name = 'OrgLockBusyError';
        this.destinationOrgId = destinationOrgId;
    }
}

class OrgLockStoreUnavailableError extends OrgLockError {
    constructor(message) {
        super(
            message ||
                'Destination org lock store is not configured.',
            'LOCK_STORE_UNAVAILABLE'
        );
        this.name = 'OrgLockStoreUnavailableError';
    }
}

class OrgLockOwnershipError extends OrgLockError {
    constructor(message) {
        super(message || 'Lock owner or generation does not match.', 'LOCK_OWNERSHIP');
        this.name = 'OrgLockOwnershipError';
    }
}

class OrgLockIdentityError extends OrgLockError {
    constructor(message) {
        super(message || 'Destination org identity verification failed.', 'LOCK_IDENTITY');
        this.name = 'OrgLockIdentityError';
    }
}

class OrgLockFenceError extends OrgLockError {
    constructor(message) {
        super(
            message || 'Lock generation no longer matches; deployment start fenced.',
            'LOCK_FENCE'
        );
        this.name = 'OrgLockFenceError';
    }
}

module.exports = {
    OrgLockError,
    OrgLockBusyError,
    OrgLockStoreUnavailableError,
    OrgLockOwnershipError,
    OrgLockIdentityError,
    OrgLockFenceError
};
