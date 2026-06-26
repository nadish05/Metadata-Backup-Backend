const sourceValidateService = require('../services/sourceValidate.service');

exports.validateSource = async (req, res) => {
    try {
        const {
            sourceOrgId,
            selectedMetadata,
            selectedTestClasses
        } = req.body;

        const result = await sourceValidateService.validateSource({
            sourceOrgId,
            selectedMetadata,
            selectedTestClasses
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
