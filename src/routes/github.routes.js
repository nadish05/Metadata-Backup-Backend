const express = require('express');

const router = express.Router();

const {
    checkGit,
    cloneRepo
} = require('../controllers/github.controller');

router.get(
    '/check-git',
    checkGit
);

router.post(
    '/clone',
    cloneRepo
);

module.exports = router;