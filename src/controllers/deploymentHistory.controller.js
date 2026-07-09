const deploymentHistoryService = require('../services/deploymentHistory.service');

const VALID_STATUSES = new Set([
    'SUCCESS',
    'FAILED',
    'BLOCKED',
    'IN_PROGRESS'
]);

const VALID_DEPLOYMENT_MODES = new Set(['VALIDATE', 'DEPLOY']);
const VALID_SORT_VALUES = new Set(['asc', 'desc']);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function parseLimit(value) {
    if (value === undefined || value === null || value === '') {
        return {
            limit: deploymentHistoryService.DEFAULT_LIST_LIMIT
        };
    }

    const parsed = Number.parseInt(String(value), 10);

    if (
        !Number.isFinite(parsed) ||
        parsed < 1 ||
        parsed > deploymentHistoryService.MAX_LIST_LIMIT
    ) {
        return {
            error: `limit must be between 1 and ${deploymentHistoryService.MAX_LIST_LIMIT}.`
        };
    }

    return { limit: parsed };
}

function parseStatus(value) {
    if (value === undefined || value === null || value === '') {
        return {};
    }

    const status = String(value).toUpperCase();

    if (!VALID_STATUSES.has(status)) {
        return {
            error: 'status must be one of SUCCESS, FAILED, BLOCKED, or IN_PROGRESS.'
        };
    }

    return { status };
}

function parseDeploymentMode(value) {
    if (value === undefined || value === null || value === '') {
        return {};
    }

    const deploymentMode = String(value).toUpperCase();

    if (!VALID_DEPLOYMENT_MODES.has(deploymentMode)) {
        return {
            error: 'deploymentMode must be VALIDATE or DEPLOY.'
        };
    }

    return { deploymentMode };
}

function parseSort(value) {
    if (value === undefined || value === null || value === '') {
        return { sort: 'desc' };
    }

    const sort = String(value).toLowerCase();

    if (!VALID_SORT_VALUES.has(sort)) {
        return {
            error: 'sort must be asc or desc.'
        };
    }

    return { sort };
}

function parseListQuery(query = {}) {
    const errors = [];
    const options = {};

    const limitResult = parseLimit(query.limit);

    if (limitResult.error) {
        errors.push(limitResult.error);
    } else {
        options.limit = limitResult.limit;
    }

    const statusResult = parseStatus(query.status);

    if (statusResult.error) {
        errors.push(statusResult.error);
    } else if (statusResult.status) {
        options.status = statusResult.status;
    }

    const modeResult = parseDeploymentMode(query.deploymentMode);

    if (modeResult.error) {
        errors.push(modeResult.error);
    } else if (modeResult.deploymentMode) {
        options.deploymentMode = modeResult.deploymentMode;
    }

    const sortResult = parseSort(query.sort);

    if (sortResult.error) {
        errors.push(sortResult.error);
    } else {
        options.sort = sortResult.sort;
    }

    return { errors, options };
}

function sendQueryError(res, message, statusCode = 400) {
    return res.status(statusCode).json({
        success: false,
        message
    });
}

exports.listHistory = (req, res) => {
    try {
        logSection('Deployment History Query Started');

        const { errors, options } = parseListQuery(req.query);

        if (errors.length) {
            return sendQueryError(res, errors.join(' '));
        }

        logSection('Applying Filters');
        console.log('Filters:', options);

        logSection('Sorting Results');
        const history = deploymentHistoryService.listHistory(options);

        logSection('Returning History');

        return res.json({
            success: true,
            count: history.length,
            history
        });
    } catch (error) {
        console.error('DEPLOYMENT HISTORY QUERY ERROR');
        console.error(error);

        return sendQueryError(
            res,
            'Unable to retrieve deployment history.',
            500
        );
    }
};

exports.getHistoryById = (req, res) => {
    try {
        logSection('Deployment History Query Started');

        const historyId = req.params.historyId;
        const history = deploymentHistoryService.getHistory(historyId);

        if (!history) {
            return sendQueryError(
                res,
                'Deployment history not found.',
                404
            );
        }

        logSection('Returning History');

        return res.json({
            success: true,
            history
        });
    } catch (error) {
        console.error('DEPLOYMENT HISTORY QUERY ERROR');
        console.error(error);

        return sendQueryError(
            res,
            'Unable to retrieve deployment history.',
            500
        );
    }
};

exports.getLatestHistory = (req, res) => {
    try {
        logSection('Deployment History Query Started');

        const history = deploymentHistoryService.getLatest();

        if (!history) {
            return sendQueryError(
                res,
                'Deployment history not found.',
                404
            );
        }

        logSection('Returning History');

        return res.json({
            success: true,
            history
        });
    } catch (error) {
        console.error('DEPLOYMENT HISTORY QUERY ERROR');
        console.error(error);

        return sendQueryError(
            res,
            'Unable to retrieve deployment history.',
            500
        );
    }
};

exports.getStatistics = (req, res) => {
    try {
        logSection('Deployment History Query Started');

        const statistics = deploymentHistoryService.getStatistics();

        logSection('Statistics Generated');

        return res.json({
            success: true,
            statistics
        });
    } catch (error) {
        console.error('DEPLOYMENT HISTORY QUERY ERROR');
        console.error(error);

        return sendQueryError(
            res,
            'Unable to retrieve deployment history statistics.',
            500
        );
    }
};
