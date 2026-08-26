'use strict';

/**
 * ControlPlaneApi artifact REST is deferred. Do not invent binary upload routes.
 * Apex DeploymentSnapshotArtifactService exists but is not exposed on REST.
 */
const MISSING_CONTROL_PLANE_ENDPOINTS = Object.freeze({
    snapshotArtifactPut:
        'POST /services/apexrest/control-plane/snapshots/{id}/artifacts — REST binary upload is deferred by ControlPlaneApi.',
    snapshotArtifactGet:
        'GET artifact bytes — DeploymentSnapshotArtifactService.getArtifactBytes is not exposed on ControlPlaneApi.',
    snapshotArtifactExists:
        'Artifact exists-by-artifactId — ControlPlaneApi has no artifact lookup by artifactId.',
    snapshotArtifactMetadata:
        'GET artifact metadata by artifactId — ControlPlaneApi has no artifact metadata route.',
    snapshotMemberGet:
        'GET /control-plane/snapshots/{id}/members/{type}/{name} — not routed; list members is used instead.',
    historyGet:
        'GET /services/apexrest/deployment-history/{historyId} — DeploymentHistoryApi is POST-create only.',
    historyUpdate:
        'PATCH /services/apexrest/deployment-history/{historyId} — not exposed.',
    historyList:
        'GET /services/apexrest/deployment-history — list/find is not exposed.',
    operationListBySnapshot:
        'GET operations?snapshotId= — ControlPlaneApi find requires destinationOrgId and snapshotId.',
    operationListBySalesforceDeploymentId:
        'GET operations by salesforceDeploymentId — not exposed on ControlPlaneApi.',
    lockAdminRelease:
        'POST /control-plane/locks/admin-release — ControlPlaneApi does not expose adminRelease.'
});

module.exports = {
    MISSING_CONTROL_PLANE_ENDPOINTS
};
