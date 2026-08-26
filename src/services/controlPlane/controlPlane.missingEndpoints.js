'use strict';

/**
 * Remaining ControlPlaneApi / DeploymentHistoryApi gaps after P0-R7.4.
 * Artifact REST and history GET/PATCH/list/find are implemented.
 */
const MISSING_CONTROL_PLANE_ENDPOINTS = Object.freeze({
    snapshotMemberGet:
        'GET /control-plane/snapshots/{id}/members/{type}/{name} — not routed; list members is used instead.',
    operationListBySnapshot:
        'GET operations?snapshotId= — ControlPlaneApi find requires destinationOrgId and snapshotId.',
    operationListBySalesforceDeploymentId:
        'GET operations by salesforceDeploymentId — not exposed on ControlPlaneApi.',
    lockAdminRelease:
        'POST /control-plane/locks/admin-release — ControlPlaneApi does not expose adminRelease.',
    failedRetrySameScope:
        'ROLLBACK FAILED retry with a new operationId on the same Rollback_Scope_Key__c is not representable while that field remains unique. See CONTROL_PLANE_SCHEMA_DECISIONS.failedRetryScope.',
    unknownResultReconciliation:
        'Authoritative Salesforce destination deployment-status lookup is unavailable. UNKNOWN_RESULT remains fail-closed.'
});

module.exports = {
    MISSING_CONTROL_PLANE_ENDPOINTS
};
