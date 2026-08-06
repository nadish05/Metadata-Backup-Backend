/**
 * Source Org Metadata API discovery.
 *
 * Reuses the existing OAuth store, token refresh, and Salesforce API-version
 * discovery used elsewhere. Discovery is fail-safe so embedded metadata
 * versions remain available as the negotiation fallback.
 */

const { getOAuthResult } = require('./oauthStore');

async function discoverSourceMetadataApiVersion({
    deploymentPackage = null,
    sourceOrg = getOAuthResult(),
    refreshAccessTokenFn = null,
    getLatestApiVersionFn = null
} = {}) {
    if (
        !deploymentPackage ||
        !sourceOrg?.refreshToken ||
        !sourceOrg?.instanceUrl ||
        typeof refreshAccessTokenFn !== 'function' ||
        typeof getLatestApiVersionFn !== 'function'
    ) {
        return null;
    }

    try {
        const tokenResult = await refreshAccessTokenFn(
            sourceOrg.refreshToken
        );
        const sourceInstanceUrl =
            tokenResult?.instanceUrl || sourceOrg.instanceUrl;
        const sourceApiVersion = await getLatestApiVersionFn(
            sourceInstanceUrl,
            tokenResult?.accessToken
        );

        if (!sourceApiVersion) {
            return null;
        }

        deploymentPackage.sourceApiVersion = String(sourceApiVersion);
        return deploymentPackage.sourceApiVersion;
    } catch (error) {
        console.error('SOURCE MAX API VERSION ERROR');
        console.error(error);
        return null;
    }
}

module.exports = {
    discoverSourceMetadataApiVersion
};
