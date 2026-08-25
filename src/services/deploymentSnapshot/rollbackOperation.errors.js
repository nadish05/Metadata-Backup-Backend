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

class RollbackOperationScopeBusyError extends RollbackOperationError {
    constructor(message) {
        super(
            message ||
                'Another rollback operation is mutating the same destination and snapshot scope.',
            'ROLLBACK_OPERATION_SCOPE_BUSY'
        );
        this.name = 'RollbackOperationScopeBusyError';
    }
}

class RollbackOperationScopeAmbiguousError extends RollbackOperationError {
    constructor(message) {
        super(
            message ||
                'Rollback scope state is ambiguous and cannot be used to start Salesforce execution.',
            'ROLLBACK_OPERATION_SCOPE_AMBIGUOUS'
        );
        this.name = 'RollbackOperationScopeAmbiguousError';
    }
}

module.exports = {
    RollbackOperationError,
    RollbackOperationStateError,
    RollbackOperationNotFoundError,
    RollbackOperationPersistenceError,
    RollbackOperationSchemaError,
    RollbackOperationScopeBusyError,
    RollbackOperationScopeAmbiguousError
};
