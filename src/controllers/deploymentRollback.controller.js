'use strict';

const deploymentRollbackService = require('../services/deploymentRollback.service');
const deploymentRollbackAsyncService = require('../services/deploymentRollbackAsync.service');
const {
    ROLLBACK_OPERATION_STATUS
} = require('../services/deploymentSnapshot/rollbackOperation.types');

exports.rollbackDeployment = async (req, res) => {
    try {
        const result = await deploymentRollbackService.executeRollback(
            req.body || {}
        );

        return res.status(result.httpStatus || 200).json(result.body);
    } catch (error) {
        console.error('DEPLOYMENT ROLLBACK ERROR');
        console.error(error);

        return res.status(500).json({
            success: false,
            blocked: false,
            failed: true,
            unknownResult: false,
            code: 'ROLLBACK_INTERNAL_ERROR',
            message:
                error.message ||
                'Unable to execute destination rollback.'
        });
    }
};

exports.startRollback = async (req, res) => {
    try {
        const accepted = await deploymentRollbackAsyncService.startRollback(
            req.body || {}
        );

        if (accepted.httpStatus && accepted.body) {
            return res.status(accepted.httpStatus).json(accepted.body);
        }

        return res.status(202).json(accepted);
    } catch (error) {
        console.error('DEPLOYMENT ROLLBACK START ERROR');
        console.error(error);

        return res.status(500).json({
            success: false,
            accepted: false,
            status: ROLLBACK_OPERATION_STATUS.FAILED,
            error:
                error.message ||
                'Unable to start destination rollback.'
        });
    }
};

exports.getRollbackStatus = async (req, res) => {
    try {
        const operationId =
            req.params?.operationId ||
            req.query?.operationId ||
            null;

        if (!operationId) {
            return res.status(400).json({
                success: false,
                error: 'operationId is required.',
                operationId: null
            });
        }

        const statusResult =
            await deploymentRollbackAsyncService.getRollbackStatus(
                operationId
            );

        if (!statusResult.found) {
            return res.status(404).json({
                success: false,
                error: 'Rollback operation not found.',
                operationId: operationId || null
            });
        }

        return res.json(statusResult.body);
    } catch (error) {
        console.error('DEPLOYMENT ROLLBACK STATUS ERROR');
        console.error(error);

        return res.status(500).json({
            success: false,
            error:
                error.message ||
                'Unable to retrieve rollback operation status.'
        });
    }
};
