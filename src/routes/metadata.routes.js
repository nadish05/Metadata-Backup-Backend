const express = require('express');

const router = express.Router();

const {
    checkSfCli
} = require('../controllers/metadata.controller');

router.get('/check-cli', checkSfCli);

module.exports = router;