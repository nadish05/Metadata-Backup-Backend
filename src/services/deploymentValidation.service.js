const axios = require('axios');

const metadataValidationService = require('./metadataValidation.service');

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function resolveErrorMessage(error) {
    const oauthError = error.response?.data;

    if (oauthError?.error === 'invalid_grant') {
        return 'Refresh token is expired or invalid.';
    }

    if (oauthError?.error === 'invalid_client') {
        return 'Invalid Salesforce client credentials.';
    }

    if (oauthError?.error_description) {
        return oauthError.error_description;
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return 'Unable to reach Salesforce. Network connection failed.';
    }

    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return 'Salesforce request timed out.';
    }

    if (error.response?.status >= 500) {
        return 'Salesforce is currently unavailable.';
    }

    if (error.response?.status === 401) {
        return 'Unable to authenticate with destination org.';
    }

    return error.message || 'Unable to authenticate with destination org.';
}

async function refreshAccessToken(refreshToken) {
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
        accessToken: tokenResponse.data.access_token,
        instanceUrl: tokenResponse.data.instance_url
    };
}

async function verifyDestinationApiAccess(accessToken, instanceUrl) {
    const response = await axios.get(
        `${instanceUrl}/services/data/`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return response.status >= 200 && response.status < 300;
}

async function validateDestinationConnectivity({
    refreshToken,
    instanceUrl,
    orgId
}) {
    logSection('Deployment Validation Started');

    if (!refreshToken || !instanceUrl) {
        console.log('Destination authentication failed.');

        return {
            success: false,
            deploymentValidation: {
                destinationConnected: false,
                status: 'BLOCKED',
                message: 'Missing destination org credentials.'
            }
        };
    }

    console.log('Generating destination access token...');

    try {
        const tokenResult = await refreshAccessToken(refreshToken);
        const resolvedInstanceUrl =
            tokenResult.instanceUrl || instanceUrl;

        console.log('Destination authentication successful.');

        const apiReachable = await verifyDestinationApiAccess(
            tokenResult.accessToken,
            resolvedInstanceUrl
        );

        if (!apiReachable) {
            console.log('Destination authentication failed.');

            return {
                success: false,
                deploymentValidation: {
                    destinationConnected: false,
                    status: 'BLOCKED',
                    message: 'Unable to authenticate with destination org.'
                }
            };
        }

        logSection('Deployment Validation Complete.');

        return {
            success: true,
            deploymentValidation: {
                destinationConnected: true,
                status: 'PASS',
                message: 'Successfully authenticated with destination org.'
            }
        };
    } catch (error) {
        console.log('Destination authentication failed.');
        console.error(error.response?.data || error.message);

        return {
            success: false,
            deploymentValidation: {
                destinationConnected: false,
                status: 'BLOCKED',
                message: resolveErrorMessage(error)
            }
        };
    }
}

async function validateDeployment({
    refreshToken,
    instanceUrl,
    orgId,
    deploymentPackage
}) {
    const connectivityResult = await validateDestinationConnectivity({
        refreshToken,
        instanceUrl,
        orgId
    });

    if (!deploymentPackage) {
        return connectivityResult;
    }

    const metadataValidation =
        await metadataValidationService.validateMetadataPackage(
            deploymentPackage
        );

    return {
        ...connectivityResult,
        metadataValidation
    };
}

module.exports = {
    validateDestinationConnectivity,
    validateDeployment
};
