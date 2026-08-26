const express =
    require('express');

const router =
    express.Router();

const deploymentController =
    require(
        '../controllers/deployment.controller'
    );

const deploymentRollbackController = require('../controllers/deploymentRollback.controller');

const deploymentAiResolutionController = require('../controllers/deploymentAiResolution.controller');
const deploymentSupportBundleController = require('../controllers/deploymentSupportBundle.controller');

router.post(
    '/analyze',
    deploymentController.analyzeDependencies
);

// Async validation transport (start → background → poll).
// Registered before /validate for clarity; paths do not collide.
router.post(
    '/validate/start',
    deploymentController.startDeploymentValidation
);

router.get(
    '/validate/status/:validationId',
    deploymentController.getDeploymentValidationStatus
);

// Existing synchronous validation — unchanged for backward compatibility.
router.post(
    '/validate',
    deploymentController.validateDeployment
);

router.post(
    '/rollback',
    deploymentRollbackController.rollbackDeployment
);

router.post(
    '/ai-resolution',
    deploymentAiResolutionController.resolveDeploymentWithAi
);

router.post(
    '/support-bundle',
    deploymentSupportBundleController.createSupportBundle
);

module.exports =
    router;