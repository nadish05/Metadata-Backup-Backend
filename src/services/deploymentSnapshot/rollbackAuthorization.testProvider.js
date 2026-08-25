'use strict';

/**
 * Test-only rollback authorization provider.
 * Do not use as a production default.
 */

const {
    ROLLBACK_AUTHORIZATION_ACTION,
    ROLLBACK_AUTHORIZATION_DECISION
} = require('./rollbackAuthorization.types');
const {
    isTrustedActor,
    createTrustedActorContext,
    TRUSTED_ACTOR_SOURCE
} = require('./rollbackActor.context');
const { buildAuthorizationDecision } = require('./rollbackAuthorization.service');

function createTestTrustedActor(overrides = {}) {
    return createTrustedActorContext({
        actorId: 'test-rollback-actor',
        actorType: 'APPLICATION_ACTOR',
        source: TRUSTED_ACTOR_SOURCE.TEST_AUTHORIZATION_PROVIDER,
        ...overrides
    });
}

function createTestRollbackAuthorizationProvider({
    rollback = false,
    recover = false,
    reconcile = false,
    unavailable = false,
    allowedDestinationOrgId = null
} = {}) {
    const lastRequest = { current: null };

    return {
        lastRequest,
        async authorize(request = {}) {
            lastRequest.current = {
                action: request.action || null,
                destinationOrgId: request.destinationOrgId || null,
                snapshotId: request.snapshotId || null,
                operationId: request.operationId || null,
                historyId: request.historyId || null,
                actorId: request.actor?.actorId || null
            };

            if (unavailable) {
                return buildAuthorizationDecision({
                    ...request,
                    decision: ROLLBACK_AUTHORIZATION_DECISION.UNAVAILABLE,
                    reasonCode: 'AUTHORIZATION_UNAVAILABLE',
                    message: 'Test authorization provider is unavailable.'
                });
            }

            if (!isTrustedActor(request.actor)) {
                return buildAuthorizationDecision({
                    ...request,
                    decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                    reasonCode: 'NO_ACTOR',
                    message: 'Test authorization provider requires a trusted actor.'
                });
            }

            if (
                allowedDestinationOrgId &&
                request.destinationOrgId &&
                request.destinationOrgId !== allowedDestinationOrgId
            ) {
                return buildAuthorizationDecision({
                    ...request,
                    decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                    reasonCode: 'DESTINATION_NOT_AUTHORIZED',
                    message: 'Actor is not authorized for this destination org.'
                });
            }

            const allowed =
                (request.action === ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK &&
                    rollback) ||
                (request.action === ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECOVER &&
                    recover) ||
                (request.action ===
                    ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK_RECONCILE &&
                    reconcile);

            return buildAuthorizationDecision({
                ...request,
                decision: allowed
                    ? ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED
                    : ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                reasonCode: allowed ? 'AUTHORIZED' : 'ACTION_DENIED',
                message: allowed
                    ? 'Test authorization provider granted the action.'
                    : 'Test authorization provider denied the action.'
            });
        }
    };
}

module.exports = {
    createTestTrustedActor,
    createTestRollbackAuthorizationProvider
};
