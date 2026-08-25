'use strict';

class DeploymentHistoryError extends Error {
    constructor(message, code = 'DEPLOYMENT_HISTORY_ERROR') {
        super(message);
        this.name = 'DeploymentHistoryError';
        this.code = code;
    }
}

class HistoryDuplicateError extends DeploymentHistoryError {
    constructor(historyId) {
        super(
            `Deployment history already exists: ${historyId}`,
            'HISTORY_DUPLICATE'
        );
        this.name = 'HistoryDuplicateError';
        this.historyId = historyId;
    }
}

class HistoryCorrelationConflictError extends DeploymentHistoryError {
    constructor(message) {
        super(message, 'HISTORY_CORRELATION_CONFLICT');
        this.name = 'HistoryCorrelationConflictError';
    }
}

class HistoryStateError extends DeploymentHistoryError {
    constructor(message) {
        super(message, 'HISTORY_STATE_ERROR');
        this.name = 'HistoryStateError';
    }
}

module.exports = {
    DeploymentHistoryError,
    HistoryDuplicateError,
    HistoryCorrelationConflictError,
    HistoryStateError
};
