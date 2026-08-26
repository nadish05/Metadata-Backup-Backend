'use strict';

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');
const {
    fromSalesforceRollbackScopeKey,
    toSalesforceRollbackScopeKey,
    toSalesforceRollbackScopeKeyFromNode
} = require('./controlPlane.scopeKey');
const { sfField, toIso, toText } = require('./controlPlane.record');

const ROLLBACK_OPERATION_SCHEMA_VERSION = 1;
const ROLLBACK_OPERATION_STATUS = Object.freeze({
    NOT_STARTED: 'NOT_STARTED',
    IN_PROGRESS: 'IN_PROGRESS',
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    UNKNOWN_RESULT: 'UNKNOWN_RESULT'
});
const TERMINAL_ROLLBACK_OPERATION_STATUSES = Object.freeze([
    ROLLBACK_OPERATION_STATUS.SUCCEEDED,
    ROLLBACK_OPERATION_STATUS.FAILED,
    ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
]);

const PRECEDENCE = Object.freeze({
    [ROLLBACK_OPERATION_STATUS.SUCCEEDED]: 4,
    [ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT]: 3,
    [ROLLBACK_OPERATION_STATUS.IN_PROGRESS]: 2,
    [ROLLBACK_OPERATION_STATUS.NOT_STARTED]: 1,
    [ROLLBACK_OPERATION_STATUS.FAILED]: 0
});

function statusPrecedence(status) {
    const rank = PRECEDENCE[status];

    if (rank === undefined) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `Unsupported rollback operation status: ${status}`
        );
    }

    return rank;
}

function canOverwriteStatus(current, requested, { allowReconciliation = false } = {}) {
    if (!requested || requested === current) {
        return true;
    }

    if (allowReconciliation && current === ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT) {
        return false;
    }

    if (requested === ROLLBACK_OPERATION_STATUS.FAILED) {
        if (
            current === ROLLBACK_OPERATION_STATUS.IN_PROGRESS ||
            current === ROLLBACK_OPERATION_STATUS.SUCCEEDED ||
            current === ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        ) {
            return current === ROLLBACK_OPERATION_STATUS.IN_PROGRESS;
        }
    }

    return statusPrecedence(requested) >= statusPrecedence(current);
}

function toSalesforceOperationCreatePayload(record) {
    const rollbackScopeKey = record.rollbackScopeKey
        ? toSalesforceRollbackScopeKeyFromNode(record.rollbackScopeKey)
        : toSalesforceRollbackScopeKey(record.destinationOrgId, record.snapshotId);

    return {
        operationId: record.operationId,
        destinationOrgId: record.destinationOrgId,
        snapshotId: record.snapshotId,
        rollbackScopeKey,
        retryOfOperationId: record.retryOfOperationId || null
    };
}

function toSalesforceOperationPatchPayload(patch = {}) {
    const payload = {};

    if (Object.prototype.hasOwnProperty.call(patch, 'resultCode')) {
        payload.resultCode = patch.resultCode;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'resultMessage')) {
        payload.resultMessage = patch.resultMessage;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'salesforceDeploymentId')) {
        payload.salesforceDeploymentId = patch.salesforceDeploymentId;
    }

    return payload;
}

function fromSalesforceOperation(record) {
    if (!record || typeof record !== 'object') {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_INVALID_RESPONSE,
            'Rollback operation record is missing.'
        );
    }

    const salesforceScope = toText(
        sfField(record, 'Rollback_Scope_Key__c', 'rollbackScopeKey')
    );
    const parsedScope = salesforceScope
        ? fromSalesforceRollbackScopeKey(salesforceScope)
        : null;

    return {
        schemaVersion: ROLLBACK_OPERATION_SCHEMA_VERSION,
        operationId: toText(sfField(record, 'Operation_Id__c', 'operationId')),
        destinationOrgId:
            toText(sfField(record, 'Destination_Org_Id__c', 'destinationOrgId')) ||
            (parsedScope && parsedScope.destinationOrgId),
        snapshotId:
            toText(sfField(record, 'Snapshot_Id__c', 'snapshotId')) ||
            (parsedScope && parsedScope.snapshotId),
        rollbackScopeKey: parsedScope ? parsedScope.nodeKey : null,
        activeScopeKey: mapActiveScopeKey(record),
        status: toText(sfField(record, 'Status__c', 'status')),
        retryOfOperationId: toText(
            sfField(record, 'Retry_Of_Operation_Id__c', 'retryOfOperationId')
        ),
        createdAt: toIso(sfField(record, 'Created_At__c', 'createdAt')),
        updatedAt: toIso(sfField(record, 'Updated_At__c', 'updatedAt')),
        executionStartedAt: toIso(
            sfField(record, 'Execution_Started_At__c', 'executionStartedAt')
        ),
        completedAt: toIso(sfField(record, 'Completed_At__c', 'completedAt')),
        salesforceDeploymentId: toText(
            sfField(record, 'Salesforce_Deployment_Id__c', 'salesforceDeploymentId')
        ),
        resultCode: toText(sfField(record, 'Result_Code__c', 'resultCode')),
        resultMessage: toText(sfField(record, 'Result_Message__c', 'resultMessage'))
    };
}

function mapActiveScopeKey(record) {
    const salesforceActive = toText(
        sfField(record, 'Active_Scope_Key__c', 'activeScopeKey')
    );

    if (!salesforceActive) {
        return null;
    }

    return fromSalesforceRollbackScopeKey(salesforceActive).nodeKey;
}

function isTerminalStatus(status) {
    return TERMINAL_ROLLBACK_OPERATION_STATUSES.includes(status);
}

module.exports = {
    PRECEDENCE,
    canOverwriteStatus,
    fromSalesforceOperation,
    isTerminalStatus,
    statusPrecedence,
    toSalesforceOperationCreatePayload,
    toSalesforceOperationPatchPayload,
    ROLLBACK_OPERATION_STATUS
};
