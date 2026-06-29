const deploymentReviewService = require('../services/deploymentReview.service');

exports.reviewDeployment = async (req, res) => {
    try {
        const result = await deploymentReviewService.runDeploymentReview(
            req.body
        );

        return res.json(result);
    } catch (error) {
        console.error('DEPLOYMENT REVIEW ERROR');
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
