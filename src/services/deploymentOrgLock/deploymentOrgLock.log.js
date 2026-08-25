'use strict';

function logLockEvent(event, details = {}) {
    console.log(event);
    console.log(
        JSON.stringify({
            destinationOrgId: details.destinationOrgId ?? null,
            operationType: details.operationType ?? null,
            ownerId: details.ownerId ?? null,
            leaseGeneration: details.leaseGeneration ?? null,
            lockId: details.lockId ?? null,
            historyId: details.historyId ?? null,
            snapshotId: details.snapshotId ?? null,
            actor: details.actor ?? null,
            reason: details.reason ?? null
        })
    );
}

module.exports = {
    logLockEvent
};
