const deploymentReviewService = require('../services/deploymentReview.service');

exports.reviewDeployment = async (req, res) => {
    try {
        const { metadataType, filePath, workspace } = req.body;

        const result = await deploymentReviewService.runDeploymentReview({
            metadataType,
            filePath,
            workspace
        });

        return res.json(result);
    } catch (error) {
        console.error('DEPLOYMENT REVIEW ERROR');
        console.error(error);

        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
};
