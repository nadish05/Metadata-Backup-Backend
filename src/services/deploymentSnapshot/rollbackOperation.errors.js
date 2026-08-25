'use strict';

class RollbackOperationError extends Error {
    constructor(message, code = 'ROLLBACK_OPERATION_ERROR') {
        super(message);
        this.name = 'RollbackOperationError';
        this.code = code;
    }
}

class RollbackOperationStateError extends RollbackOperationError {
    constructor(message) {
        super(message, 'ROLLBACK_OPERATION_STATE');
        this.name = 'RollbackOperationStateError';
    }
}

class RollbackOperationNotFoundError extends RollbackOperationError {
    constructor(operationId) {
        super(
            `Rollback operation not found: ${operationId}`,
            'ROLLBACK_OPERATION_NOT_FOUND'
        );
        this.name = 'RollbackOperationNotFoundError';
        this.operationId = operationId;
    }
}

class RollbackOperationPersistenceError extends RollbackOperationError {
    constructor(message) {
        super(
            message || 'Rollback operation store is unavailable.',
            'ROLLBACK_OPERATION_PERSISTENCE'
        );
        this.name = 'RollbackOperationPersistenceError';
    }
}

class RollbackOperationSchemaError extends RollbackOperationError {
    constructor(message) {
        super(message, 'ROLLBACK_OPERATION_SCHEMA');
        this.name = 'RollbackOperationSchemaError';
    }
}

module.exports = {
    RollbackOperationError,
    RollbackOperationStateError,
    RollbackOperationNotFoundError,
    RollbackOperationPersistenceError,
    RollbackOperationSchemaError
};
