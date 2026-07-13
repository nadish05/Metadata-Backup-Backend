const axios = require('axios');

const { refreshAccessToken } = require('./checkOnlyDeployment.service');

/**
 * Application Salesforce Org Apex REST helper.
 *
 * Mirrors the Connected Org Apex REST calling pattern used historically
 * (axios POST to /services/apexrest/*, Bearer token, JSON body).
 *
 * Authenticates against the APPLICATION org (LWC / Apex / custom objects),
 * never against a deployment destination org.
 */
function getApplicationOrgConfig() {
    const instanceUrl = process.env.SF_APP_INSTANCE_URL || null;
    const refreshToken = process.env.SF_APP_REFRESH_TOKEN || null;

    return {
        instanceUrl,
        refreshToken
    };
}

async function getApplicationOrgAccessToken() {
    const { instanceUrl, refreshToken } = getApplicationOrgConfig();

    if (!instanceUrl || !refreshToken) {
        return {
            success: false,
            accessToken: null,
            instanceUrl: null,
            message:
                'Application org credentials are not configured (SF_APP_INSTANCE_URL / SF_APP_REFRESH_TOKEN).'
        };
    }

    const tokenResult = await refreshAccessToken(refreshToken);

    return {
        success: true,
        accessToken: tokenResult.accessToken,
        instanceUrl: tokenResult.instanceUrl || instanceUrl,
        message: null
    };
}

/**
 * POST JSON to an Application Org Apex REST resource.
 *
 * @param {string} resourcePath e.g. '/services/apexrest/deployment-history'
 * @param {object} payload
 * @returns {Promise<{ success, data, httpStatus, message }>}
 */
async function postToApplicationOrgApex(resourcePath, payload) {
    const auth = await getApplicationOrgAccessToken();

    if (!auth.success || !auth.accessToken || !auth.instanceUrl) {
        return {
            success: false,
            data: null,
            httpStatus: null,
            message:
                auth.message ||
                'Unable to authenticate with Application Salesforce Org.'
        };
    }

    const normalizedPath = resourcePath.startsWith('/')
        ? resourcePath
        : `/${resourcePath}`;

    const url = `${auth.instanceUrl}${normalizedPath}`;

    const response = await axios.post(url, payload, {
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
        },
        timeout: 30000
    });

    return {
        success: true,
        data: response.data || {},
        httpStatus: response.status,
        message: null,
        url
    };
}

module.exports = {
    getApplicationOrgConfig,
    getApplicationOrgAccessToken,
    postToApplicationOrgApex
};
