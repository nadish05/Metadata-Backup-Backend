const express = require('express');

const router = express.Router();

const {
    getDifferentFiles
} = require('../controllers/compare.controller');

router.post(
    '/files',
    getDifferentFiles
);

module.exports = router;