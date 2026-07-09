const express = require('express');

const router = express.Router();

const deploymentHistoryController = require('../controllers/deploymentHistory.controller');

router.get('/history', deploymentHistoryController.listHistory);
router.get('/history/latest', deploymentHistoryController.getLatestHistory);
router.get('/history/statistics', deploymentHistoryController.getStatistics);
router.get('/history/:historyId', deploymentHistoryController.getHistoryById);

module.exports = router;
