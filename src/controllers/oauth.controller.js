const axios = require('axios');

const {
    setOAuthResult,
    getOAuthResult
} = require('../services/oauthStore');

exports.startOAuth = async (req, res) => {

    try {

        const environment =
            req.query.environment || 'Production';

        const loginUrl =
            environment === 'Sandbox'
                ? 'https://test.salesforce.com'
                : 'https://login.salesforce.com';

        const authUrl =
                `${loginUrl}/services/oauth2/authorize` +
                `?response_type=code` +
                `&client_id=${process.env.SF_CLIENT_ID}` +
                `&redirect_uri=${encodeURIComponent(process.env.SF_CALLBACK_URL)}` +
                `&state=${environment}`;

        res.json({
            success: true,
            authUrl
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

};

exports.callbackOAuth = async (req, res) => {

    try {

        const code = req.query.code;
        const environment =
            req.query.state || 'Production';

        const tokenUrl =
            environment === 'Sandbox'
                ? 'https://test.salesforce.com/services/oauth2/token'
                : 'https://login.salesforce.com/services/oauth2/token';

        const response = await axios.post(
            tokenUrl,
            null,
            {
                params: {
                    grant_type: 'authorization_code',
                    client_id: process.env.SF_CLIENT_ID,
                    client_secret: process.env.SF_CLIENT_SECRET,
                    redirect_uri: process.env.SF_CALLBACK_URL,
                    code: code
                }
            }
        );

const idUrl = new URL(response.data.id);

const segments = idUrl.pathname.split('/');

const orgInfo = {
    orgId: segments[2],
    userId: segments[3],
    instanceUrl: response.data.instance_url,
    refreshToken: response.data.refresh_token
};

setOAuthResult(orgInfo);

res.json({
    success: true,
    orgInfo
});
    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });

    }

};

exports.getLatestOAuth = async (req, res) => {
    res.json({
        success: true,
        data: getOAuthResult()
    });
};