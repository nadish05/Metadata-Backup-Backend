/**
 * Phase 18.3.3 — Route-scoped JSON body limit for Support Bundle only.
 *
 * Global express.json() remains ~100 KB.
 * POST /api/deployment/support-bundle allows up to 1 MB.
 * Does not alter Support Bundle business logic.
 */

'use strict';

const express = require('express');

const SUPPORT_BUNDLE_PATH = '/api/deployment/support-bundle';
const SUPPORT_BUNDLE_JSON_LIMIT = '1mb';

const SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE = Object.freeze({
    success: false,
    error: 'SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE',
    message:
        'Support Bundle request is too large. Please retry the validation and generate the Support Bundle again.'
});

/**
 * Mount the 1 MB JSON parser for the Support Bundle path.
 * Must be registered BEFORE the global ~100 KB express.json().
 */
function mountSupportBundleJsonParser(app) {
    app.use(
        SUPPORT_BUNDLE_PATH,
        express.json({ limit: SUPPORT_BUNDLE_JSON_LIMIT })
    );
}

function isEntityTooLargeError(err) {
    if (!err) {
        return false;
    }
    return (
        err.type === 'entity.too.large' ||
        err.status === 413 ||
        err.statusCode === 413
    );
}

function isSupportBundleRequest(req) {
    const path = String(req?.originalUrl || req?.url || '').split('?')[0];
    return (
        path === SUPPORT_BUNDLE_PATH ||
        path.endsWith('/deployment/support-bundle')
    );
}

/**
 * Minimal error middleware: clean JSON 413 for Support Bundle oversize only.
 * Does not expose stack, raw body, or secrets.
 */
function supportBundlePayloadTooLargeHandler(err, req, res, next) {
    if (!isEntityTooLargeError(err) || !isSupportBundleRequest(req)) {
        return next(err);
    }

    return res.status(413).json({ ...SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE });
}

/**
 * Apply production JSON parsing order + Support Bundle 413 handler.
 * Used by app.js and focused HTTP tests.
 */
function applyJsonBodyParsing(app) {
    mountSupportBundleJsonParser(app);
    // Global default remains Express/body-parser ~100 KB.
    app.use(express.json());
}

function applySupportBundlePayloadTooLargeHandler(app) {
    app.use(supportBundlePayloadTooLargeHandler);
}

module.exports = {
    SUPPORT_BUNDLE_PATH,
    SUPPORT_BUNDLE_JSON_LIMIT,
    SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE,
    mountSupportBundleJsonParser,
    supportBundlePayloadTooLargeHandler,
    applyJsonBodyParsing,
    applySupportBundlePayloadTooLargeHandler,
    isEntityTooLargeError,
    isSupportBundleRequest
};
