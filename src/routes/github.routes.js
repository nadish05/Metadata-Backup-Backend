const express = require('express');

const router = express.Router();

const {
    checkGit
} = require('../controllers/github.controller');

router.get(
    '/check-git',
    checkGit
);

module.exports = router;