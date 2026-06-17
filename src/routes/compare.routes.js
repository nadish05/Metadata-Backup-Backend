const express = require('express');

const router = express.Router();

const {
    getDifferentFiles,
    getDifferenceReport
    //getFileContent
} = require('../controllers/compare.controller');

router.post(
    '/files',
    getDifferentFiles
);

router.post(
    '/report',
    getDifferenceReport
);

//router.post(
    '/file-content',
    getFileContent
//);

module.exports = router;