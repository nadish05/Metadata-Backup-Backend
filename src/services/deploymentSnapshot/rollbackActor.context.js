'use strict';

const { ACTOR_TRUST } = require('./rollbackAuthorization.types');

const TRUSTED_ACTOR_SOURCE = Object.freeze({
    TEST_AUTHORIZATION_PROVIDER: 'test-authorization-provider',
    FUTURE_AUTH_ADAPTER: 'future-auth-adapter'
});

function createTrustedActorContext({
    actorId,
    actorType = 'APPLICATION_ACTOR',
    displayName = null,
    source,
    authenticatedAt = new Date().toISOString()
} = {}) {
    if (!actorId || typeof actorId !== 'string' || !actorId.trim()) {
        return Object.freeze({
            trustLevel: ACTOR_TRUST.INVALID_ACTOR_CONTEXT,
            actorId: null,
            actorType: null,
            displayName: null,
            source: source || null,
            authenticatedAt: null
        });
    }

    if (
        source !== TRUSTED_ACTOR_SOURCE.TEST_AUTHORIZATION_PROVIDER &&
        source !== TRUSTED_ACTOR_SOURCE.FUTURE_AUTH_ADAPTER
    ) {
        return Object.freeze({
            trustLevel: ACTOR_TRUST.INVALID_ACTOR_CONTEXT,
            actorId: null,
            actorType: null,
            displayName: null,
            source: source || null,
            authenticatedAt: null
        });
    }

    return Object.freeze({
        trustLevel: ACTOR_TRUST.TRUSTED_ACTOR,
        actorId: actorId.trim(),
        actorType: actorType || 'APPLICATION_ACTOR',
        displayName: displayName || null,
        source,
        authenticatedAt
    });
}

function resolveActorContext(value) {
    if (!value) {
        return Object.freeze({
            trustLevel: ACTOR_TRUST.UNAUTHENTICATED,
            actorId: null,
            actorType: null,
            displayName: null,
            source: null,
            authenticatedAt: null
        });
    }

    if (value.trustLevel === ACTOR_TRUST.TRUSTED_ACTOR && value.actorId) {
        if (
            value.source !== TRUSTED_ACTOR_SOURCE.TEST_AUTHORIZATION_PROVIDER &&
            value.source !== TRUSTED_ACTOR_SOURCE.FUTURE_AUTH_ADAPTER
        ) {
            return Object.freeze({
                trustLevel: ACTOR_TRUST.INVALID_ACTOR_CONTEXT,
                actorId: null,
                actorType: null,
                displayName: null,
                source: value.source || null,
                authenticatedAt: null
            });
        }

        return value;
    }

    if (value.trustLevel === ACTOR_TRUST.INVALID_ACTOR_CONTEXT) {
        return value;
    }

    return Object.freeze({
        trustLevel: ACTOR_TRUST.UNAUTHENTICATED,
        actorId: null,
        actorType: null,
        displayName: null,
        source: null,
        authenticatedAt: null
    });
}

function isTrustedActor(actor) {
    const resolved = resolveActorContext(actor);

    return resolved.trustLevel === ACTOR_TRUST.TRUSTED_ACTOR;
}

module.exports = {
    TRUSTED_ACTOR_SOURCE,
    createTrustedActorContext,
    resolveActorContext,
    isTrustedActor
};
