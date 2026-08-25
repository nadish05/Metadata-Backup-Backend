'use strict';

/**
 * Authorization wrapper around lock adminRelease.
 * Does not change lock lease/steal semantics.
 */

const { orgIdsMatch } = require('../deploymentOrgLock/destinationOrgIdentity.service');

function createAuthorizedLockRecovery({
    lockService,
    recoveryContract,
    resolveVerifiedDestinationOrgId
} = {}) {
    async function recoverDestinationLock({
        actor,
        destinationOrgId,
        reason,
        snapshotId = null,
        operationId = null,
        refreshToken,
        instanceUrl
    } = {}) {
        if (!lockService || typeof lockService.adminRelease !== 'function') {
            return {
                released: false,
                code: 'ROLLBACK_RECOVERY_UNAVAILABLE',
                message: 'Lock service is unavailable for recovery.'
            };
        }

        let verifiedOrgId = destinationOrgId;

        if (typeof resolveVerifiedDestinationOrgId === 'function') {
            verifiedOrgId = await resolveVerifiedDestinationOrgId({
                refreshToken,
                instanceUrl,
                requestedOrgId: destinationOrgId
            });
        }

        if (!verifiedOrgId) {
            return {
                released: false,
                code: 'ROLLBACK_RECOVERY_DENIED',
                message: 'Verified destination org is required for recovery.'
            };
        }

        if (destinationOrgId && !orgIdsMatch(verifiedOrgId, destinationOrgId)) {
            return {
                released: false,
                code: 'ROLLBACK_RECOVERY_DENIED',
                message: 'Verified destination org does not match recovery request.'
            };
        }

        const gate = await recoveryContract.authorizeRecovery({
            actor,
            destinationOrgId: verifiedOrgId,
            snapshotId,
            operationId,
            reason
        });

        if (!gate.allowed) {
            return {
                released: false,
                code:
                    gate.authorization?.decision === 'UNAVAILABLE'
                        ? 'ROLLBACK_AUTHORIZATION_UNAVAILABLE'
                        : 'ROLLBACK_RECOVERY_DENIED',
                authorization: gate.authorization,
                message:
                    gate.authorization?.message ||
                    'Lock recovery is not authorized.'
            };
        }

        const released = lockService.adminRelease({
            destinationOrgId: verifiedOrgId,
            reason: String(reason).trim(),
            actor: actor.actorId
        });

        return {
            released: true,
            lock: released,
            authorization: gate.authorization
        };
    }

    return {
        recoverDestinationLock
    };
}

module.exports = {
    createAuthorizedLockRecovery
};
