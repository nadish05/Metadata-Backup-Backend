const express = require('express');

const router = express.Router();

const {
    startOAuth,
    callbackOAuth,
    getLatestOAuth
} = require('../controllers/oauth.controller');

router.get('/start', startOAuth);
router.get('/callback', callbackOAuth);
router.get('/latest', getLatestOAuth);

module.exports = router;