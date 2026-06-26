const express = require('express');

const router = express.Router();

const sourceValidateController = require('../controllers/sourceValidate.controller');

router.post(
    '/source-validate',
    sourceValidateController.validateSource
);

module.exports = router;
