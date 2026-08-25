'use strict';

const { RollbackOperationPersistenceError } = require('../rollbackOperation.errors');

function createUnavailableRollbackOperationStore(message) {
    const fail = async () => {
        throw new RollbackOperationPersistenceError(message);
    };

    return {
        createOperation: fail,
        getOperation: fail,
        updateOperation: fail,
        findBySnapshotId: fail,
        findByOperationId: fail,
        findBySalesforceDeploymentId: fail,
        findByDestinationAndSnapshot: fail,
        getScope: fail,
        withExclusiveScope: fail
    };
}

module.exports = {
    createUnavailableRollbackOperationStore
};
