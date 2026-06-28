const express = require('express');

const router = express.Router();

const sourceValidationController = require('../controllers/sourceValidation.controller');

router.post(
    '/source-validation',
    sourceValidationController.runSourceValidation
);

module.exports = router;
