const express = require('express');

const router = express.Router();

const {
    checkSfCli,
    testSfAuth,
    retrieveMetadata,
    retrieveAllMetadata
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

router.post(
    '/retrieve-all',
    retrieveAllMetadata
);

module.exports = router;

