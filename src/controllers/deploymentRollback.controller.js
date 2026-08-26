'use strict';

const deploymentRollbackService = require('../services/deploymentRollback.service');

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
