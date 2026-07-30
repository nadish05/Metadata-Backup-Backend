/**
 * Flow Review destination enrichment — Phase 3.
 *
 * Reuses Destination Inventory Builder against Phase 2 dependency inventory.
 * Does not rediscover dependencies or re-parse Flow XML.
 */

const axios = require('axios');

const {
    buildDestinationInventory,
    getState,
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');

/**
 * Resolve destination access token from optional Review credentials.
 * Accepts a ready accessToken or refreshes from refreshToken.
 *
 * @param {{
 *   refreshToken?: string|null,
 *   accessToken?: string|null,
 *   instanceUrl?: string|null
 * }} credentials
 * @returns {Promise<{ accessToken: string|null, instanceUrl: string|null }>}
 */
async function resolveDestinationCredentials(credentials = {}) {
    const instanceUrl = credentials.instanceUrl || null;
    const existingToken = credentials.accessToken || null;

    if (existingToken && instanceUrl) {
        return {
            accessToken: existingToken,
            instanceUrl
        };
    }

    const refreshToken = credentials.refreshToken || null;

    if (!refreshToken || !instanceUrl) {
        return {
            accessToken: null,
            instanceUrl
        };
    }

    try {
        const tokenResponse = await axios.post(
            'https://login.salesforce.com/services/oauth2/token',
            null,
            {
                params: {
                    grant_type: 'refresh_token',
                    client_id: process.env.SF_CLIENT_ID,
                    client_secret: process.env.SF_CLIENT_SECRET,
                    refresh_token: refreshToken
                },
                timeout: 15000
            }
        );

        return {
            accessToken: tokenResponse.data.access_token || null,
            instanceUrl: tokenResponse.data.instance_url || instanceUrl
        };
    } catch (error) {
        return {
            accessToken: null,
            instanceUrl
        };
    }
}

/**
 * Attach destinationState (EXISTS | MISSING | UNKNOWN) to each dependency.
 * Uses existing inventory builder — never invents EXISTS/MISSING on errors.
 *
 * @param {Array<object>} dependencies
 * @param {{
 *   refreshToken?: string|null,
 *   accessToken?: string|null,
 *   instanceUrl?: string|null
 * }} [destinationCredentials]
 * @returns {Promise<{
 *   requiredDependencies: Array<object>,
 *   destinationValidationSummary: object|null
 * }>}
 */
async function enrichFlowDependenciesWithDestinationState(
    dependencies,
    destinationCredentials = {}
) {
    if (!Array.isArray(dependencies) || !dependencies.length) {
        return {
            requiredDependencies: [],
            destinationValidationSummary: null
        };
    }

    const resolved = await resolveDestinationCredentials(
        destinationCredentials
    );

    const inventoryResult = await buildDestinationInventory({
        items: dependencies,
        accessToken: resolved.accessToken,
        instanceUrl: resolved.instanceUrl
    });

    const requiredDependencies = dependencies.map((dependency) => {
        const metadataType = dependency?.type || dependency?.metadataType;
        const metadataName = dependency?.name || dependency?.metadataName;

        return {
            ...dependency,
            destinationState: getState(
                inventoryResult.inventory,
                metadataType,
                metadataName
            )
        };
    });

    return {
        requiredDependencies,
        destinationValidationSummary: inventoryResult.summary || null
    };
}

module.exports = {
    resolveDestinationCredentials,
    enrichFlowDependenciesWithDestinationState,
    DESTINATION_STATE
};
