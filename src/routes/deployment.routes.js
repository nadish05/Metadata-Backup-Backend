const express =
    require('express');

const router =
    express.Router();

const deploymentController =
    require(
        '../controllers/deployment.controller'
    );

const deploymentAiResolutionController = require('../controllers/deploymentAiResolution.controller');

router.post(
    '/analyze',
    deploymentController.analyzeDependencies
);

router.post(
    '/validate',
    deploymentController.validateDeployment
);

router.post(
    '/ai-resolution',
    deploymentAiResolutionController.resolveDeploymentWithAi
);

module.exports =
    router;