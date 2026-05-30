const express = require('express');

const router = express.Router();

const {
    checkSfCli,
    testSfAuth
} = require('../controllers/metadata.controller');

router.get('/check-cli', checkSfCli);

router.post(
    '/test-auth',
    testSfAuth
);

module.exports = router;

