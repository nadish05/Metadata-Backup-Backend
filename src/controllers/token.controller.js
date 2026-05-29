const axios = require('axios');

exports.refreshAccessToken = async (req, res) => {

    try {

        const { refreshToken } = req.body;

        const response = await axios.post(
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

        res.json({
            success: true,
            accessToken: response.data.access_token,
            instanceUrl: response.data.instance_url
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });

    }

};