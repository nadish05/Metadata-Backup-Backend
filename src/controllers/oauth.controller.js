exports.startOAuth = async (req, res) => {

    try {

        const authUrl =
            'OAuth URL Will Come Here';

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