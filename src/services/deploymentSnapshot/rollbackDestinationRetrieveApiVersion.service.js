'use strict';

const { DEFAULT_API_VERSION } = require('../../config/salesforce');
const {
    minApiVersion,
    normalizeApiVersion
} = require('../deploymentApiNegotiation.service');
const { getLatestApiVersion } = require('../destinationInventory/destinationInventoryBuilder.service');

function resolveRollbackDestinationRetrieveSourceApiVersion({
    snapshotSourceMetadataApiVersion = null,
    deploymentApiVersion = null,
    destinationMaxApiVersion = null
} = {}) {
    const stored = normalizeApiVersion(snapshotSourceMetadataApiVersion);
    const deployment = normalizeApiVersion(deploymentApiVersion);
    const destinationMax = normalizeApiVersion(destinationMaxApiVersion);

    if (stored) {
        const effectiveRetrieveApiVersion = destinationMax
            ? minApiVersion(stored, destinationMax)
            : stored;

        return {
            snapshotSourceMetadataApiVersion: stored,
            deploymentApiVersion: deployment,
            destinationMaxApiVersion: destinationMax,
            effectiveRetrieveApiVersion,
            retrieveApiVersionSelection: 'SNAPSHOT_SOURCE_METADATA',
            defaultApiVersion: DEFAULT_API_VERSION
        };
    }

    if (deployment) {
        return {
            snapshotSourceMetadataApiVersion: null,
            deploymentApiVersion: deployment,
            destinationMaxApiVersion: destinationMax,
            effectiveRetrieveApiVersion: deployment,
            retrieveApiVersionSelection: 'DEPLOYMENT_API_VERSION_FALLBACK',
            defaultApiVersion: DEFAULT_API_VERSION
        };
    }

    return {
        snapshotSourceMetadataApiVersion: null,
        deploymentApiVersion: null,
        destinationMaxApiVersion: destinationMax,
        effectiveRetrieveApiVersion: null,
        retrieveApiVersionSelection: 'DEFAULT_FALLBACK',
        defaultApiVersion: DEFAULT_API_VERSION
    };
}

async function resolveRollbackDestinationRetrieveSourceApiVersionWithDestinationCap({
    snapshot = null,
    deploymentApiVersion = null,
    refreshToken = null,
    instanceUrl = null,
    accessToken = null,
    getLatestApiVersionFn = getLatestApiVersion,
    refreshAccessTokenFn = null
} = {}) {
    let destinationMaxApiVersion = null;

    if (typeof getLatestApiVersionFn === 'function') {
        let resolvedAccessToken = accessToken;
        let resolvedInstanceUrl = instanceUrl;

        if (!resolvedAccessToken && refreshToken && refreshAccessTokenFn) {
            try {
                const tokenResult = await refreshAccessTokenFn(refreshToken);
                resolvedAccessToken = tokenResult?.accessToken || null;
                resolvedInstanceUrl =
                    tokenResult?.instanceUrl || instanceUrl || null;
            } catch (error) {
                void error;
            }
        }

        if (resolvedAccessToken && resolvedInstanceUrl) {
            try {
                destinationMaxApiVersion = await getLatestApiVersionFn(
                    resolvedInstanceUrl,
                    resolvedAccessToken
                );
            } catch (error) {
                void error;
            }
        }
    }

    return resolveRollbackDestinationRetrieveSourceApiVersion({
        snapshotSourceMetadataApiVersion:
            snapshot?.sourceMetadataApiVersion ?? null,
        deploymentApiVersion,
        destinationMaxApiVersion
    });
}

function logRollbackRetrieveApiVersionDiagnostic(payload) {
    console.log('ROLLBACK_API_VERSION_DIAGNOSTIC', JSON.stringify(payload));
}

module.exports = {
    resolveRollbackDestinationRetrieveSourceApiVersion,
    resolveRollbackDestinationRetrieveSourceApiVersionWithDestinationCap,
    logRollbackRetrieveApiVersionDiagnostic
};
