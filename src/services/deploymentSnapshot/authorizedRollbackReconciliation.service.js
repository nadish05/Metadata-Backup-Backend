'use strict';

function createAuthorizedRollbackReconciliation({
    operationService,
    recoveryContract
} = {}) {
    async function reconcileUnknownOperationAuthorized({
        actor,
        operationId,
        destinationOrgId,
        snapshotId = null,
        reason = null,
        salesforceStatus = null,
        salesforceDeploymentId = null
    } = {}) {
        const gate = await recoveryContract.authorizeReconcile({
            actor,
            destinationOrgId,
            snapshotId,
            operationId
        });

        if (!gate.allowed) {
            return {
                reconciled: false,
                blocked: true,
                code:
                    gate.authorization?.decision === 'UNAVAILABLE'
                        ? 'ROLLBACK_AUTHORIZATION_UNAVAILABLE'
                        : 'ROLLBACK_RECONCILE_DENIED',
                authorization: gate.authorization,
                operation: null
            };
        }

        const resolved = await recoveryContract.resolveAuthoritativeEvidence({
            destinationOrgId,
            salesforceDeploymentId,
            callerSuppliedStatus: salesforceStatus
        });

        if (!resolved.usable) {
            return {
                reconciled: false,
                blocked: true,
                code: 'ROLLBACK_RECONCILE_EVIDENCE_UNAVAILABLE',
                evidence: resolved.evidence,
                authorization: gate.authorization,
                operation: operationId
                    ? await operationService.getOperation?.(operationId)
                    : null
            };
        }

        const operation = await operationService.reconcileUnknownOperation({
            operationId,
            salesforceDeploymentId: resolved.evidence.salesforceDeploymentId,
            salesforceStatus: resolved.evidence.status,
            actor: actor.actorId,
            reason
        });

        return {
            reconciled:
                operation.status !== 'UNKNOWN_RESULT' &&
                operation.status !== undefined,
            blocked: false,
            operation,
            evidence: resolved.evidence,
            authorization: gate.authorization
        };
    }

    return {
        reconcileUnknownOperationAuthorized
    };
}

module.exports = {
    createAuthorizedRollbackReconciliation
};
