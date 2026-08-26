'use strict';

const { createSalesforceControlPlaneClient } = require('./controlPlane.client');
const { resolveControlPlaneAuth } = require('./controlPlane.auth');

let testOverrides = null;

function setControlPlaneTestOverrides(overrides) {
    testOverrides = overrides || null;
}

function resetControlPlaneTestOverrides() {
    testOverrides = null;
}

function getControlPlaneTestOverrides() {
    return testOverrides;
}

function createControlPlaneClientFromAuth(auth, extras = {}) {
    return createSalesforceControlPlaneClient({
        accessToken: auth.accessToken,
        instanceUrl: auth.instanceUrl,
        httpRequest: extras.httpRequest || (testOverrides && testOverrides.httpRequest),
        timeoutMs: extras.timeoutMs
    });
}

function getSharedControlPlaneClient() {
    if (testOverrides && testOverrides.client) {
        return testOverrides.client;
    }

    const auth = resolveControlPlaneAuth({
        provider: testOverrides && testOverrides.authProvider
    });

    if (!auth.ok) {
        throw auth.error;
    }

    return createControlPlaneClientFromAuth(auth, {
        httpRequest: testOverrides && testOverrides.httpRequest
    });
}

module.exports = {
    createControlPlaneClientFromAuth,
    getControlPlaneTestOverrides,
    getSharedControlPlaneClient,
    resetControlPlaneTestOverrides,
    setControlPlaneTestOverrides
};
