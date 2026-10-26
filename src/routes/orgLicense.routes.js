const express = require('express');

const router = express.Router();

const { compareOrgUserLicenses } = require('../controllers/orgLicense.controller');

router.post('/compare', compareOrgUserLicenses);

module.exports = router;
