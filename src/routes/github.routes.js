const express = require('express');

const router = express.Router();

const {
    checkGit,
    cloneRepo,
    migrateToGitHub
} = require('../controllers/github.controller');

router.get(
    '/check-git',
    checkGit
);

router.post(
    '/clone',
    cloneRepo
);

router.post(
    '/migrate',
    migrateToGitHub
);

module.exports = router;