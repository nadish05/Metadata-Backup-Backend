'use strict';

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');

/**
 * Node captureStatus values do not match Salesforce Capture_Status__c.
 * Mapping is explicit and fail-closed. UNKNOWN↔SKIPPED is semantic, not identical.
 */
const NODE_CAPTURE_STATUS = Object.freeze({
    COMPLETE: 'COMPLETE',
    ABSENT_PROVEN: 'ABSENT_PROVEN',
    UNKNOWN: 'UNKNOWN',
    FAILED: 'FAILED'
});

const SALESFORCE_CAPTURE_STATUS = Object.freeze({
    PENDING: 'PENDING',
    CAPTURING: 'CAPTURING',
    CAPTURED: 'CAPTURED',
    FAILED: 'FAILED',
    SKIPPED: 'SKIPPED',
    NOT_REQUIRED: 'NOT_REQUIRED'
});

const NODE_TO_SALESFORCE = Object.freeze({
    [NODE_CAPTURE_STATUS.COMPLETE]: SALESFORCE_CAPTURE_STATUS.CAPTURED,
    [NODE_CAPTURE_STATUS.ABSENT_PROVEN]: SALESFORCE_CAPTURE_STATUS.NOT_REQUIRED,
    [NODE_CAPTURE_STATUS.UNKNOWN]: SALESFORCE_CAPTURE_STATUS.SKIPPED,
    [NODE_CAPTURE_STATUS.FAILED]: SALESFORCE_CAPTURE_STATUS.FAILED
});

const SALESFORCE_TO_NODE = Object.freeze({
    [SALESFORCE_CAPTURE_STATUS.CAPTURED]: NODE_CAPTURE_STATUS.COMPLETE,
    [SALESFORCE_CAPTURE_STATUS.NOT_REQUIRED]: NODE_CAPTURE_STATUS.ABSENT_PROVEN,
    [SALESFORCE_CAPTURE_STATUS.SKIPPED]: NODE_CAPTURE_STATUS.UNKNOWN,
    [SALESFORCE_CAPTURE_STATUS.FAILED]: NODE_CAPTURE_STATUS.FAILED
});

function toSalesforceCaptureStatus(nodeStatus) {
    const mapped = NODE_TO_SALESFORCE[nodeStatus];

    if (!mapped) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `Node captureStatus "${nodeStatus}" cannot be mapped to Salesforce Capture_Status__c.`
        );
    }

    return mapped;
}

function toNodeCaptureStatus(salesforceStatus) {
    const mapped = SALESFORCE_TO_NODE[salesforceStatus];

    if (!mapped) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `Salesforce Capture_Status__c "${salesforceStatus}" cannot be mapped to Node captureStatus.`
        );
    }

    return mapped;
}

module.exports = {
    NODE_CAPTURE_STATUS,
    NODE_TO_SALESFORCE,
    SALESFORCE_CAPTURE_STATUS,
    SALESFORCE_TO_NODE,
    toNodeCaptureStatus,
    toSalesforceCaptureStatus
};
