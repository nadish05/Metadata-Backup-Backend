const express = require('express');

const router = express.Router();

const deploymentReviewController = require('../controllers/deploymentReview.controller');

router.post(
    '/review',
    deploymentReviewController.reviewDeployment
);

module.exports = router;
