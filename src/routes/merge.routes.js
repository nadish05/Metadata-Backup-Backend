'use strict';

const express = require('express');

const router = express.Router();

const mergeController = require('../controllers/merge.controller');

router.post('/apex/sessions', mergeController.createMergeSession);
router.get('/apex/sessions/:id', mergeController.getMergeSession);
router.post('/apex/sessions/:id/preview', mergeController.previewMergeSession);
router.post('/apex/sessions/:id/resolve', mergeController.resolveMergeSession);
router.post('/apex/sessions/:id/seal', mergeController.sealMergeSession);

module.exports = router;
