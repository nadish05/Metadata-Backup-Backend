exports.startOAuth = async (req, res) => {

    try {

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

    } catch(error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

};

        res.json({
            success: true,
            authUrl
        });

    }
    catch(error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

};