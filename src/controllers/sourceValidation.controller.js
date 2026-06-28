const sourceValidationService = require('../services/sourceValidation.service');

exports.runSourceValidation = async (req, res) => {
    try {
        const { connectedOrgId, deploymentPackage } = req.body;

        const result = await sourceValidationService.runSourceValidation({
            connectedOrgId,
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
