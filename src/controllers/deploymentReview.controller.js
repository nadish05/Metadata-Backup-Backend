const deploymentReviewService = require('../services/deploymentReview.service');

exports.reviewDeployment = async (req, res) => {
    try {
        // TEMPORARY DEBUG — incoming Deployment Review payload (remove after trace).
        {
            const body = req.body || {};
            console.log('==========================================================');
            console.log('DEPLOYMENT REVIEW REQUEST');
            console.log('==========================================================');
            console.log('selectedMetadata');
            console.log(
                JSON.stringify(body.selectedMetadata ?? null, null, 2)
            );
            console.log('requiredDependencies');
            console.log(
                JSON.stringify(body.requiredDependencies ?? null, null, 2)
            );
            console.log('deploymentPackage.selectedMetadata (if present)');
            console.log(
                JSON.stringify(
                    body.deploymentPackage?.selectedMetadata ?? null,
                    null,
                    2
                )
            );
            console.log('==========================================================');
        }

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
