/**
 * Source Org Metadata API discovery.
 *
 * Reuses the existing OAuth store, token refresh, and Salesforce API-version
 * discovery used elsewhere. Discovery is fail-safe so embedded metadata
 * versions remain available as the negotiation fallback.
 */

const { getOAuthResult } = require('./oauthStore');
const sourceApiDiscoveryTrace = require('./sourceApiDiscoveryTrace.temp');

async function discoverSourceMetadataApiVersion({
    deploymentPackage = null,
    sourceOrg = getOAuthResult(),
    refreshAccessTokenFn = null,
    getLatestApiVersionFn = null
} = {}) {
    // TEMP (Phase 13.5.1) — discovery trace steps 2-6. Logging only.
    sourceApiDiscoveryTrace.traceSourceOrgLookup({
        lookupSource: 'oauthStore.getOAuthResult()',
        connectedOrgFound: Boolean(
            sourceOrg?.refreshToken && sourceOrg?.instanceUrl
        ),
        orgId: sourceOrg?.orgId || null,
        instanceUrl: sourceOrg?.instanceUrl || null,
        refreshTokenPresent: Boolean(sourceOrg?.refreshToken)
    });

    if (
        !deploymentPackage ||
        !sourceOrg?.refreshToken ||
        !sourceOrg?.instanceUrl ||
        typeof refreshAccessTokenFn !== 'function' ||
        typeof getLatestApiVersionFn !== 'function'
    ) {
        sourceApiDiscoveryTrace.traceResolvedSourceApi({
            resolvedApiVersion: null
        });
        sourceApiDiscoveryTrace.traceSourceApiStored({ stored: false });
        return null;
    }

    let sourceInstanceUrl = sourceOrg.instanceUrl;

    try {
        const tokenResult = await refreshAccessTokenFn(
            sourceOrg.refreshToken
        );

        sourceApiDiscoveryTrace.traceSourceAuthentication({
            accessTokenGenerated: Boolean(tokenResult?.accessToken)
        });

        sourceInstanceUrl = tokenResult?.instanceUrl || sourceOrg.instanceUrl;
        const sourceApiVersion = await getLatestApiVersionFn(
            sourceInstanceUrl,
            tokenResult?.accessToken
        );

        sourceApiDiscoveryTrace.traceApiDiscovery({
            executed: true,
            endpoint: `${sourceInstanceUrl}/services/data/`,
            httpStatus: sourceApiVersion ? 200 : null,
            responseBody: sourceApiVersion
                ? `latest version ${sourceApiVersion}`
                : '(no versions returned)'
        });
        sourceApiDiscoveryTrace.traceResolvedSourceApi({
            resolvedApiVersion: sourceApiVersion || null
        });

        if (!sourceApiVersion) {
            sourceApiDiscoveryTrace.traceSourceApiStored({ stored: false });
            return null;
        }

        deploymentPackage.sourceApiVersion = String(sourceApiVersion);

        sourceApiDiscoveryTrace.traceSourceApiStored({
            stored: true,
            storedValue: deploymentPackage.sourceApiVersion
        });

        return deploymentPackage.sourceApiVersion;
    } catch (error) {
        sourceApiDiscoveryTrace.traceSourceAuthentication({
            accessTokenGenerated: false,
            authenticationError:
                error?.response?.data?.error_description ||
                error?.response?.data?.error ||
                error?.message ||
                'Source org authentication failed.'
        });
        sourceApiDiscoveryTrace.traceApiDiscovery({
            executed: Boolean(error?.response),
            endpoint: `${sourceInstanceUrl}/services/data/`,
            httpStatus: error?.response?.status || null,
            responseBody: error?.response?.data
                ? JSON.stringify(error.response.data)
                : null
        });
        sourceApiDiscoveryTrace.traceResolvedSourceApi({
            resolvedApiVersion: null
        });
        sourceApiDiscoveryTrace.traceSourceApiStored({ stored: false });

        console.error('SOURCE MAX API VERSION ERROR');
        console.error(error);
        return null;
    }
}

module.exports = {
    discoverSourceMetadataApiVersion
};
