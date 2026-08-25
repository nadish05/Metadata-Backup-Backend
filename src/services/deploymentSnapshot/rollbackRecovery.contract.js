'use strict';

const {
    ROLLBACK_AUTHORIZATION_ACTION,
    ROLLBACK_AUTHORIZATION_DECISION
} = require('./rollbackAuthorization.types');
const { resolveActorContext, isTrustedActor } = require('./rollbackActor.context');
const { isAuthoritativeSalesforceEvidence } = require('./salesforceDeployStatus.contract');

function requireRecoveryReason(reason) {
    return Boolean(reason && String(reason).trim());
}

function createRollbackRecoveryContract({
    authorizationService,
    deployStatusService
} = {}) {
    async function authorizeRecovery({
        actor,
        destinationOrgId,
        snapshotId = null,
        operationId = null,
        reason = null
    } = {}) {
        const resolved = resolveActorContext(actor);

        if (!isTrustedActor(resolved)) {
            return {
                allowed: false,
                authorization: await authorizationService.authorize({
                    actor: resolved,
                    action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER,
                    destinationOrgId,
                    snapshotId,
                    operationId
                })
            };
        }

        if (!requireRecoveryReason(reason)) {
            return {
                allowed: false,
                authorization: {
                    decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                    action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER,
                    actorId: resolved.actorId,
                    destinationOrgId,
                    snapshotId,
                    operationId,
                    reasonCode: 'REASON_REQUIRED',
                    message: 'Privileged recovery requires a non-empty reason.'
                }
            };
        }

        const authorization = await authorizationService.authorize({
            actor: resolved,
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER,
            destinationOrgId,
            snapshotId,
            operationId
        });

        return {
            allowed:
                authorization.decision ===
                ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED,
            authorization
        };
    }

    async function authorizeReconcile({
        actor,
        destinationOrgId,
        snapshotId = null,
        operationId = null
    } = {}) {
        const authorization = await authorizationService.authorize({
            actor,
            action: ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECONCILE,
            destinationOrgId,
            snapshotId,
            operationId
        });

        return {
            allowed:
                authorization.decision ===
                ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED,
            authorization
        };
    }

    async function resolveAuthoritativeEvidence({
        destinationOrgId,
        salesforceDeploymentId,
        callerSuppliedStatus = null
    } = {}) {
        void callerSuppliedStatus;

        if (!deployStatusService || typeof deployStatusService.getDeploymentStatus !== 'function') {
            return {
                usable: false,
                evidence: {
                    status: 'UNAVAILABLE',
                    authoritative: false,
                    salesforceDeploymentId: salesforceDeploymentId || null,
                    message: 'Salesforce deploy status service is unavailable.'
                }
            };
        }

        const evidence = await deployStatusService.getDeploymentStatus({
            destinationOrgId,
            salesforceDeploymentId
        });

        return {
            usable: isAuthoritativeSalesforceEvidence(evidence),
            evidence
        };
    }

    return {
        authorizeRecovery,
        authorizeReconcile,
        resolveAuthoritativeEvidence,
        requireRecoveryReason
    };
}

module.exports = {
    createRollbackRecoveryContract,
    requireRecoveryReason
};
