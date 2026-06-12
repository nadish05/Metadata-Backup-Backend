const express = require('express');

const router = express.Router();

const {
    checkGit,
    cloneRepo,
    migrateToGitHub,
    getMigrationStatus
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

router.get(
    '/migration/status',
    getMigrationStatus
);

module.exports = router;