exports.startOAuth = async (req, res) => {

    try {

        const authUrl =
            `https://login.salesforce.com/services/oauth2/authorize` +
            `?response_type=code` +
            `&client_id=${process.env.SF_CLIENT_ID}` +
            `&redirect_uri=${encodeURIComponent(process.env.SF_CALLBACK_URL)}`;

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

    const axios = require('axios');

exports.callbackOAuth = async (req, res) => {

    try {

        const code = req.query.code;

        const response = await axios.post(
            'https://login.salesforce.com/services/oauth2/token',
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

        res.json({
            success: true,
            data: response.data
        });

    } catch(error) {

        res.status(500).json({
            success: false,
            error:
                error.response?.data ||
                error.message
        });

    }

};

};