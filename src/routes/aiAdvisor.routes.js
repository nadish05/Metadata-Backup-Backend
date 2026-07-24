const express = require('express');
const router = express.Router();

const { generateAdvisor } = require('../controllers/aiAdvisor.controller');

router.post('/advisor', generateAdvisor);

module.exports = router;
