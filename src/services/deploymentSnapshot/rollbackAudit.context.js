'use strict';

function buildRollbackAuditContext({
    actor,
    action,
    destinationOrgId = null,
    snapshotId = null,
    operationId = null,
    reason = null,
    authorizationDecision = null,
    timestamp = new Date().toISOString()
} = {}) {
    return Object.freeze({
        actorId: actor?.actorId || null,
        actorType: actor?.actorType || null,
        action: action || null,
        destinationOrgId,
        snapshotId,
        operationId,
        reason: reason || null,
        authorizationDecision: authorizationDecision || null,
        timestamp
    });
}

module.exports = {
    buildRollbackAuditContext
};
