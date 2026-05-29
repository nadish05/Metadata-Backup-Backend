const express = require('express');

const router = express.Router();

const {
    startOAuth,
    callbackOAuth
} = require('../controllers/oauth.controller');

router.get('/start', startOAuth);
router.get('/callback', callbackOAuth);

module.exports = router;