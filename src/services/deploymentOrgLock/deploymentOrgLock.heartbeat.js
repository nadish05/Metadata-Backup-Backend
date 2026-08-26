'use strict';

const { DEFAULT_HEARTBEAT_MS } = require('./deploymentOrgLock.types');
const { logLockEvent } = require('./deploymentOrgLock.log');

function startLockHeartbeat({
    lockService,
    destinationOrgId,
    ownerId,
    leaseGeneration,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
}) {
    if (!lockService || typeof lockService.renew !== 'function') {
        return () => {};
    }

    const interval = setIntervalFn(() => {
        try {
            const result = lockService.renew({
                destinationOrgId,
                ownerId,
                leaseGeneration
            });

            if (result && typeof result.then === 'function') {
                result.catch(() => {
                    logLockEvent('LOCK_HEARTBEAT_FAILED', {
                        destinationOrgId,
                        ownerId,
                        leaseGeneration
                    });
                });
            }
        } catch (error) {
            logLockEvent('LOCK_HEARTBEAT_FAILED', {
                destinationOrgId,
                ownerId,
                leaseGeneration
            });
        }
    }, heartbeatMs);

    if (interval && typeof interval.unref === 'function') {
        interval.unref();
    }

    return function stopLockHeartbeat() {
        clearIntervalFn(interval);
    };
}

module.exports = {
    startLockHeartbeat
};
