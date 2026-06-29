const axios = require('axios');
const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

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

async function connectToSourceOrg({ refreshToken, instanceUrl }) {
    if (!refreshToken || !instanceUrl) {
        throw new Error('Missing org credentials');
    }

    const alias = `source-validation-${Date.now()}`;

    const accessToken = await refreshAccessToken(refreshToken);

    await loginSfOrg(
        accessToken,
        instanceUrl,
        alias
    );

    return alias;
}

module.exports = {
    connectToSourceOrg
};
