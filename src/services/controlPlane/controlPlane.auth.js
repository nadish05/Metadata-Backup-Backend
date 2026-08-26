'use strict';

/**
 * Product/Control Org authentication is a separate concern from destination-org OAuth.
 * No approved production provider exists in this repository.
 * Do not invent Entra, Connected App, Named Credential, or environment variable names.
 * Do not reuse destination refresh tokens or req.body.actor.
 */

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');

const CONTROL_PLANE_AUTH_SOURCE = Object.freeze({
    NONE: 'NONE',
    TEST_PROVIDER: 'test-control-plane-auth-provider'
});

function createAuthUnavailableError() {
    return new ControlPlaneError(
        CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE,
        'Product Org authentication is unavailable. No approved Control Org credential provider is configured.'
    );
}

function resolveControlPlaneAuth({ provider } = {}) {
    if (typeof provider === 'function') {
        const resolved = provider();

        if (resolved && resolved.ok === true && resolved.accessToken && resolved.instanceUrl) {
            return {
                ok: true,
                accessToken: resolved.accessToken,
                instanceUrl: resolved.instanceUrl,
                source: resolved.source || CONTROL_PLANE_AUTH_SOURCE.TEST_PROVIDER
            };
        }

        return {
            ok: false,
            error: resolved?.error || createAuthUnavailableError()
        };
    }

    return {
        ok: false,
        error: createAuthUnavailableError()
    };
}

function requireControlPlaneAuth(options) {
    const resolved = resolveControlPlaneAuth(options);

    if (!resolved.ok) {
        throw resolved.error;
    }

    return resolved;
}

/**
 * Test-only provider. Do not use as a production default.
 */
function createTestControlPlaneAuthProvider({
    accessToken = 'test-control-plane-access-token',
    instanceUrl = 'https://control-org.example.invalid'
} = {}) {
    return function testControlPlaneAuthProvider() {
        return {
            ok: true,
            accessToken,
            instanceUrl,
            source: CONTROL_PLANE_AUTH_SOURCE.TEST_PROVIDER
        };
    };
}

module.exports = {
    CONTROL_PLANE_AUTH_SOURCE,
    createAuthUnavailableError,
    createTestControlPlaneAuthProvider,
    requireControlPlaneAuth,
    resolveControlPlaneAuth
};
