const express = require('express');

const router = express.Router();

const {
    getDifferentFiles,
    getDifferenceReport
} = require('../controllers/compare.controller');

router.post(
    '/files',
    getDifferentFiles
);

router.post(
    '/report',
    getDifferenceReport
);

module.exports = router;