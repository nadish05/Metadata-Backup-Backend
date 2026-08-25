'use strict';

const { DEFAULT_HEARTBEAT_MS } = require('./deploymentOrgLock.types');
const { logLockEvent } = require('./deploymentOrgLock.log');

function startLockHeartbeat({
    lockService,
    destinationOrgId,
    ownerId,
    leaseGeneration,
    heartbeatMs = DEFAULT_HEARTBEAT_MS
}) {
    if (!lockService || typeof lockService.renew !== 'function') {
        return () => {};
    }

    const interval = setInterval(() => {
        try {
            lockService.renew({
                destinationOrgId,
                ownerId,
                leaseGeneration
            });
        } catch (error) {
            logLockEvent('LOCK_HEARTBEAT_FAILED', {
                destinationOrgId,
                ownerId,
                leaseGeneration
            });
        }
    }, heartbeatMs);

    if (typeof interval.unref === 'function') {
        interval.unref();
    }

    return function stopLockHeartbeat() {
        clearInterval(interval);
    };
}

module.exports = {
    startLockHeartbeat
};
