const sourceValidationService = require('../services/sourceValidation.service');

exports.runSourceValidation = async (req, res) => {
    try {
        const {
            refreshToken,
            instanceUrl,
            orgId,
            deploymentPackage
        } = req.body;

        const result = await sourceValidationService.runSourceValidation({
            refreshToken,
            instanceUrl,
            orgId,
            deploymentPackage
        });

        return res.json(result);
    } catch (error) {
        console.error('SOURCE VALIDATION ERROR');
        console.error(error);

        return res.status(500).json({
            success: false,
            error:
                error.stderr ||
                error.stdout ||
                error.message
        });
    }
};
