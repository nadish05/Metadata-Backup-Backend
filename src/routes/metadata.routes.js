const express = require('express');

const router = express.Router();

const {
    checkSfCli,
    testSfAuth,
    retrieveMetadata
} = require('../controllers/metadata.controller');

router.get('/check-cli', checkSfCli);

router.post(
    '/test-auth',
    testSfAuth
);
router.post(
    '/retrieve',
    retrieveMetadata
);

module.exports = router;

