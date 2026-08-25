'use strict';

const {
    OrgLockBusyError,
    OrgLockStoreUnavailableError,
    OrgLockOwnershipError
} = require('../deploymentOrgLock.errors');

function createUnavailableOrgLockStore(message) {
    const fail = () => {
        throw new OrgLockStoreUnavailableError(message);
    };

    return {
        acquire: fail,
        renew: fail,
        release: fail,
        get: fail,
        adminRelease: fail
    };
}

module.exports = {
    createUnavailableOrgLockStore,
    OrgLockBusyError,
    OrgLockOwnershipError
};
