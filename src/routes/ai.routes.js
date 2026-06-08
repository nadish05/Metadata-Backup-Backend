const express = require('express');
const router = express.Router();

const {
    generateComparisonSummary
} = require('../controllers/ai.controller');

router.post(
    '/comparison-summary',
    generateComparisonSummary
);

module.exports = router;