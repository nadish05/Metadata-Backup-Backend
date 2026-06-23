const express =
    require('express');

const router =
    express.Router();

const deploymentController =
    require(
        '../controllers/deployment.controller'
    );

router.post(
    '/analyze',
    deploymentController.analyzeDependencies
);

module.exports =
    router;