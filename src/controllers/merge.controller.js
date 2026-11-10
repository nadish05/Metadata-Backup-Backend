'use strict';

const { ApexMergeError } = require('../services/apexMerge/apexMerge.errors');
const mergeSessionService = require('../services/apexMerge/mergeSession.service');

function mapMergeError(error) {
    if (error instanceof ApexMergeError) {
        const statusByCode = {
            SESSION_NOT_FOUND: 404,
            SESSION_EXPIRED: 410,
            STALE_GIT_PINS: 409,
            CORRELATION_MISMATCH: 409,
            DESTINATION_DRIFT_DETECTED: 409,
            UNRESOLVED_CONFLICT: 422,
            CONFLICT_MARKERS: 422,
            HASH_MISMATCH: 400,
            INVALID_MANIFEST: 400,
            INVALID_REQUEST: 400,
            DUPLICATE_CLASS_IDENTITY: 400,
            MALFORMED_CLASS_SELECTION: 400,
            MISSING_THREE_WAY_ARTIFACTS: 422,
            INVALID_RESOLUTION_STRATEGY: 400,
            SESSION_SEALED: 409
        };

        return {
            httpStatus: statusByCode[error.code] || 400,
            body: {
                success: false,
                code: error.code,
                error: error.message,
                details: error.details || null
            }
        };
    }

    return {
        httpStatus: 500,
        body: {
            success: false,
            code: 'MERGE_INTERNAL_ERROR',
            error: error.message || 'Merge operation failed.'
        }
    };
}

exports.createMergeSession = async (req, res) => {
    try {
        const result = await mergeSessionService.createMergeSession(req.body || {});
        return res.status(201).json(result);
    } catch (error) {
        const mapped = mapMergeError(error);
        return res.status(mapped.httpStatus).json(mapped.body);
    }
};

exports.previewMergeSession = async (req, res) => {
    try {
        const result = await mergeSessionService.previewMergeSession(
            req.params.id,
            req.body || {}
        );
        return res.json(result);
    } catch (error) {
        const mapped = mapMergeError(error);
        return res.status(mapped.httpStatus).json(mapped.body);
    }
};

exports.resolveMergeSession = async (req, res) => {
    try {
        const result = mergeSessionService.resolveMergeSession(
            req.params.id,
            req.body || {}
        );
        return res.json(result);
    } catch (error) {
        const mapped = mapMergeError(error);
        return res.status(mapped.httpStatus).json(mapped.body);
    }
};

exports.sealMergeSession = async (req, res) => {
    try {
        const result = mergeSessionService.sealMergeSession(
            req.params.id,
            req.body || {}
        );
        return res.json(result);
    } catch (error) {
        const mapped = mapMergeError(error);
        return res.status(mapped.httpStatus).json(mapped.body);
    }
};

exports.getMergeSession = async (req, res) => {
    try {
        const result = mergeSessionService.getMergeSession(req.params.id);
        return res.json(result);
    } catch (error) {
        const mapped = mapMergeError(error);
        return res.status(mapped.httpStatus).json(mapped.body);
    }
};
