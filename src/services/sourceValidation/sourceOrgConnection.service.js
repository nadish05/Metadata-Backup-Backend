const axios = require('axios');
const util = require('util');
const { exec } = require('child_process');

const { getOAuthResult } = require('../oauthStore');

const execAsync = util.promisify(exec);

function orgIdsMatch(storedOrgId, requestedOrgId) {
    if (!storedOrgId || !requestedOrgId) {
        return false;
    }

    return (
        storedOrgId.substring(0, 15) ===
        requestedOrgId.substring(0, 15)
    );
}

function getConnectedOrgCredentials(connectedOrgId) {
    const org = getOAuthResult();

    if (
        !org?.refreshToken ||
        !org?.instanceUrl ||
        !orgIdsMatch(org.orgId, connectedOrgId)
    ) {
        throw new Error('Connected org credentials not found');
    }

    return org;
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
            }
        }
    );

    return tokenResponse.data.access_token;
}

async function loginSfOrg(accessToken, instanceUrl, alias) {
    const loginCommand =
        `export SF_ACCESS_TOKEN="${accessToken}" && ` +
        `sf org login access-token ` +
        `-r ${instanceUrl} ` +
        `--alias ${alias} ` +
        `--no-prompt`;

    await execAsync(loginCommand);
}

async function connectToSourceOrg(connectedOrgId) {
    const org = getConnectedOrgCredentials(connectedOrgId);
    const alias = `source-validation-${Date.now()}`;

    const accessToken = await refreshAccessToken(org.refreshToken);

    await loginSfOrg(
        accessToken,
        org.instanceUrl,
        alias
    );

    return alias;
}

module.exports = {
    connectToSourceOrg
};
