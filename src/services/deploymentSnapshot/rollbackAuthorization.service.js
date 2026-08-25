'use strict';

const {
    ACTOR_TRUST,
    ROLLBACK_AUTHORIZATION_ACTION,
    ROLLBACK_AUTHORIZATION_DECISION
} = require('./rollbackAuthorization.types');
const { resolveActorContext } = require('./rollbackActor.context');

function nowIso() {
    return new Date().toISOString();
}

function buildAuthorizationDecision({
    decision,
    action,
    actor,
    destinationOrgId = null,
    snapshotId = null,
    operationId = null,
    historyId = null,
    reasonCode = null,
    message = null
} = {}) {
    const resolved = resolveActorContext(actor);

    return Object.freeze({
        decision,
        action: action || null,
        actorId: resolved.actorId,
        actorTrustLevel: resolved.trustLevel,
        destinationOrgId: destinationOrgId || null,
        snapshotId: snapshotId || null,
        operationId: operationId || null,
        historyId: historyId || null,
        reasonCode: reasonCode || null,
        message: message || null,
        timestamp: nowIso()
    });
}

function createUnavailableRollbackAuthorizationProvider() {
    return {
        async authorize(request = {}) {
            return buildAuthorizationDecision({
                ...request,
                decision: ROLLBACK_AUTHORIZATION_DECISION.UNAVAILABLE,
                reasonCode: 'AUTHORIZATION_UNAVAILABLE',
                message:
                    'Rollback authorization provider is not configured. Application actor identity is unavailable.'
            });
        }
    };
}

function createRollbackAuthorizationService({ provider } = {}) {
    const resolveProvider = () => {
        if (provider && typeof provider.authorize === 'function') {
            return provider;
        }

        return createUnavailableRollbackAuthorizationProvider();
    };

    async function authorize(request = {}) {
        const actor = resolveActorContext(request.actor);
        const action = request.action;

        if (
            !action ||
            !Object.values(ROLLBACK_AUTHORIZATION_ACTION).includes(action)
        ) {
            return buildAuthorizationDecision({
                ...request,
                actor,
                decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                reasonCode: 'INVALID_ACTION',
                message: 'Rollback authorization action is invalid.'
            });
        }

        if (actor.trustLevel === ACTOR_TRUST.UNAUTHENTICATED) {
            return buildAuthorizationDecision({
                ...request,
                actor,
                decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                reasonCode: 'NO_ACTOR',
                message: 'No trusted application actor is present.'
            });
        }

        if (actor.trustLevel === ACTOR_TRUST.INVALID_ACTOR_CONTEXT) {
            return buildAuthorizationDecision({
                ...request,
                actor,
                decision: ROLLBACK_AUTHORIZATION_DECISION.DENIED,
                reasonCode: 'INVALID_ACTOR',
                message: 'Actor context is invalid.'
            });
        }

        try {
            return await resolveProvider().authorize({
                ...request,
                actor,
                action
            });
        } catch (error) {
            return buildAuthorizationDecision({
                ...request,
                actor,
                action,
                decision: ROLLBACK_AUTHORIZATION_DECISION.UNAVAILABLE,
                reasonCode: 'AUTHORIZATION_UNAVAILABLE',
                message:
                    error.message ||
                    'Rollback authorization provider failed.'
            });
        }
    }

    return {
        authorize
    };
}

function getSharedRollbackAuthorizationService() {
    return createRollbackAuthorizationService({
        provider: createUnavailableRollbackAuthorizationProvider()
    });
}

function logAuthorizationDecision(decision) {
    if (!decision) {
        return;
    }

    console.log('ROLLBACK_AUTHORIZATION_DECISION');
    console.log(
        JSON.stringify({
            decision: decision.decision,
            action: decision.action,
            actorId: decision.actorId,
            actorTrustLevel: decision.actorTrustLevel,
            destinationOrgId: decision.destinationOrgId,
            snapshotId: decision.snapshotId,
            operationId: decision.operationId,
            reasonCode: decision.reasonCode
        })
    );
}

module.exports = {
    buildAuthorizationDecision,
    createUnavailableRollbackAuthorizationProvider,
    createRollbackAuthorizationService,
    getSharedRollbackAuthorizationService,
    logAuthorizationDecision
};
