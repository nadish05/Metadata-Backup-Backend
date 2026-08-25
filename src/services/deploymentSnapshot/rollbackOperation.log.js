'use strict';

function logRollbackOperationEvent(event, details = {}) {
    console.log(event);
    console.log(
        JSON.stringify({
            operationId: details.operationId ?? null,
            snapshotId: details.snapshotId ?? null,
            destinationOrgId: details.destinationOrgId ?? null,
            status: details.status ?? null,
            salesforceDeploymentId: details.salesforceDeploymentId ?? null,
            resultCode: details.resultCode ?? null,
            retryOfOperationId: details.retryOfOperationId ?? null,
            actor: details.actor ?? null,
            reason: details.reason ?? null
        })
    );
}

module.exports = {
    logRollbackOperationEvent
};
