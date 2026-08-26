'use strict';

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');

const SALESFORCE_SCOPE_SEPARATOR = '|';
const NODE_SCOPE_SEPARATOR = '::';

function toSalesforceRollbackScopeKey(destinationOrgId, snapshotId) {
    const dest = String(destinationOrgId || '');
    const snap = String(snapshotId || '');

    if (!dest || !snap) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'destinationOrgId and snapshotId are required for rollback scope translation.'
        );
    }

    if (dest.includes(SALESFORCE_SCOPE_SEPARATOR) || snap.includes(SALESFORCE_SCOPE_SEPARATOR)) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'destinationOrgId or snapshotId contains "|" and cannot be translated collision-safely.'
        );
    }

    return `${dest}${SALESFORCE_SCOPE_SEPARATOR}${snap}`;
}

function fromSalesforceRollbackScopeKey(salesforceKey) {
    const text = String(salesforceKey || '');
    const separatorIndex = text.indexOf(SALESFORCE_SCOPE_SEPARATOR);

    if (separatorIndex <= 0 || text.indexOf(SALESFORCE_SCOPE_SEPARATOR, separatorIndex + 1) !== -1) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'Salesforce Rollback_Scope_Key__c is not destinationOrgId|snapshotId.'
        );
    }

    const destinationOrgId = text.slice(0, separatorIndex);
    const snapshotId = text.slice(separatorIndex + 1);

    if (!destinationOrgId || !snapshotId) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'Salesforce Rollback_Scope_Key__c is incomplete.'
        );
    }

    return {
        destinationOrgId,
        snapshotId,
        nodeKey: `${destinationOrgId}${NODE_SCOPE_SEPARATOR}${snapshotId}`
    };
}

function parseNodeRollbackScopeKey(rollbackScopeKey) {
    const text = String(rollbackScopeKey || '');
    const separatorIndex = text.indexOf(NODE_SCOPE_SEPARATOR);

    if (separatorIndex <= 0) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'Node rollbackScopeKey is invalid.'
        );
    }

    return {
        destinationOrgId: text.slice(0, separatorIndex),
        snapshotId: text.slice(separatorIndex + NODE_SCOPE_SEPARATOR.length)
    };
}

function toSalesforceRollbackScopeKeyFromNode(nodeKey) {
    const parsed = parseNodeRollbackScopeKey(nodeKey);
    return toSalesforceRollbackScopeKey(parsed.destinationOrgId, parsed.snapshotId);
}

module.exports = {
    NODE_SCOPE_SEPARATOR,
    SALESFORCE_SCOPE_SEPARATOR,
    fromSalesforceRollbackScopeKey,
    parseNodeRollbackScopeKey,
    toSalesforceRollbackScopeKey,
    toSalesforceRollbackScopeKeyFromNode
};
