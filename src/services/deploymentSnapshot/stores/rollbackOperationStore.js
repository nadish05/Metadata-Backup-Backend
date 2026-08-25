'use strict';

const ROLLBACK_OPERATION_STORE_METHODS = Object.freeze([
    'createOperation',
    'getOperation',
    'updateOperation',
    'findBySnapshotId',
    'findByOperationId',
    'findBySalesforceDeploymentId',
    'findByDestinationAndSnapshot'
]);

function assertRollbackOperationStore(store) {
    if (!store || typeof store !== 'object') {
        throw new TypeError('RollbackOperationStore is required.');
    }

    for (const method of ROLLBACK_OPERATION_STORE_METHODS) {
        if (typeof store[method] !== 'function') {
            throw new TypeError(
                `RollbackOperationStore is missing method: ${method}`
            );
        }
    }
}

module.exports = {
    ROLLBACK_OPERATION_STORE_METHODS,
    assertRollbackOperationStore
};
