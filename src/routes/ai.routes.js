const express = require('express');
const router = express.Router();

const {
    generateComparisonSummary,
    explainDiff
} = require('../controllers/ai.controller');

router.post(
    '/comparison-summary',
    generateComparisonSummary
);

router.post(
    '/explain-diff',
    explainDiff
);

module.exports = router;