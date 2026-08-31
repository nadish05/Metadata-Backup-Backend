'use strict';

/**
 * Rollback HTTP adapter authorization for POST /api/deployment/rollback only.
 *
 * Does not replace getSharedRollbackAuthorizationService().
 * Does not introduce Application Org → Backend authentication.
 * Defers caller trust hardening; authorizes trusted actors produced only by
 * the rollback HTTP service path.
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
const {
    buildAuthorizationDecision,
    createRollbackAuthorizationService
} = require('./rollbackAuthorization.service');

const HTTP_ROLLBACK_ACTOR_ID = 'salesforce-application-org';

let cachedHttpAuthorizationService = null;

function createHttpRollbackTrustedActorResolver() {
    return createTrustedActorContext({
        actorId: HTTP_ROLLBACK_ACTOR_ID,
        actorType: 'APPLICATION_ACTOR',
        source: TRUSTED_ACTOR_SOURCE.FUTURE_AUTH_ADAPTER
    });
}

function createHttpRollbackAuthorizationProvider() {
    return {
        async authorize(request = {}) {
            if (!isTrustedActor(request.actor)) {
                return buildAuthorizationDecision({
                    ...request,
                    decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                    reasonCode: 'NO_ACTOR',
                    message:
                        'Rollback HTTP authorization requires a trusted application actor.'
                });
            }

            if (
                request.actor.source !==
                TRUSTED_ACTOR_SOURCE.FUTURE_AUTH_ADAPTER
            ) {
                return buildAuthorizationDecision({
                    ...request,
                    decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                    reasonCode: 'INVALID_ACTOR',
                    message: 'Rollback HTTP actor source is invalid.'
                });
            }

            if (request.action === ROLLBACK_AUTHORIZATION_ACTION.ROLLBACK) {
                return buildAuthorizationDecision({
                    ...request,
                    decision: ROLLBACK_AUTHORIZATION_DECISION.AUTHORIZED,
                    reasonCode: 'AUTHORIZED',
                    message:
                        'Rollback HTTP authorization granted for ROLLBACK.'
                });
            }

            return buildAuthorizationDecision({
                ...request,
                decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                reasonCode: 'ACTION_DENIED',
                message:
                    'Rollback HTTP authorization does not grant this action.'
            });
        }
    };
}

function createHttpRollbackAuthorizationService() {
    if (!cachedHttpAuthorizationService) {
        cachedHttpAuthorizationService = createRollbackAuthorizationService({
            provider: createHttpRollbackAuthorizationProvider()
        });
    }

    return cachedHttpAuthorizationService;
}

function resetHttpRollbackAuthorizationServiceForTests() {
    cachedHttpAuthorizationService = null;
}

function createRollbackHttpAuthorizationDependencies() {
    return {
        resolveTrustedActor: createHttpRollbackTrustedActorResolver,
        getRollbackAuthorizationService: createHttpRollbackAuthorizationService
    };
}

module.exports = {
    HTTP_ROLLBACK_ACTOR_ID,
    createHttpRollbackAuthorizationProvider,
    createHttpRollbackTrustedActorResolver,
    createHttpRollbackAuthorizationService,
    createRollbackHttpAuthorizationDependencies,
    resetHttpRollbackAuthorizationServiceForTests
};
