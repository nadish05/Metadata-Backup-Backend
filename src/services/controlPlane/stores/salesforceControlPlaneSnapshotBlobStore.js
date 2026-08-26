'use strict';

const { CONTROL_PLANE_ERROR_CODE, ControlPlaneError } = require('../controlPlane.errors');
const { createAuthUnavailableError } = require('../controlPlane.auth');
const { MISSING_CONTROL_PLANE_ENDPOINTS } = require('../controlPlane.missingEndpoints');

function resolveClient(options = {}) {
    if (options.client) {
        return options.client;
    }

    if (typeof options.getClient === 'function') {
        return options.getClient();
    }

    throw createAuthUnavailableError();
}

function missingArtifactEndpoint(endpointKey) {
    return new ControlPlaneError(
        CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
        MISSING_CONTROL_PLANE_ENDPOINTS[endpointKey]
    );
}

function createSalesforceControlPlaneSnapshotBlobStore(options = {}) {
    async function putArtifact() {
        resolveClient(options);
        throw missingArtifactEndpoint('snapshotArtifactPut');
    }

    async function getArtifact() {
        resolveClient(options);
        throw missingArtifactEndpoint('snapshotArtifactGet');
    }

    async function exists() {
        resolveClient(options);
        throw missingArtifactEndpoint('snapshotArtifactExists');
    }

    async function getMetadata() {
        resolveClient(options);
        throw missingArtifactEndpoint('snapshotArtifactMetadata');
    }

    return {
        putArtifact,
        getArtifact,
        exists,
        getMetadata
    };
}

module.exports = {
    createSalesforceControlPlaneSnapshotBlobStore
};
