'use strict';

const { sanitizeHistoryRecord } = require('../../deploymentHistory.sanitize');
const { HistoryDuplicateError } = require('../../deploymentHistory.errors');
const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('../controlPlane.errors');
const { createAuthUnavailableError } = require('../controlPlane.auth');
const {
    fromSalesforceHistoryRecord,
    toSalesforceHistoryPayload
} = require('../controlPlane.historyMapping');

function resolveClient(options = {}) {
    if (options.client) {
        return options.client;
    }

    if (typeof options.getClient === 'function') {
        return options.getClient();
    }

    throw createAuthUnavailableError();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mapHistoryReadError(error) {
    if (
        error instanceof ControlPlaneError &&
        error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
    ) {
        return null;
    }

    return error;
}

function requireHistorySuccess(result, fallbackMessage) {
    const data = result && result.data;

    if (!data || data.success !== true) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
            String((data && data.message) || fallbackMessage)
        );
    }

    return data;
}

function createSalesforceControlPlaneDeploymentHistoryStore(options = {}) {
    async function create(record) {
        if (!record?.historyId) {
            throw new TypeError('historyId is required.');
        }

        const client = resolveClient(options);
        const payload = toSalesforceHistoryPayload(record);
        const result = await client.deploymentHistory('POST', { body: payload });
        const data = result.data;

        if (!data || data.success !== true) {
            const message = String((data && data.message) || '');

            if (/duplicate/i.test(message)) {
                throw new HistoryDuplicateError(record.historyId);
            }

            throw new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
                message || 'Unable to save deployment history.'
            );
        }

        return sanitizeHistoryRecord({
            ...clone(record),
            salesforceRecordId: data.recordId || null
        });
    }

    async function get(historyId) {
        const client = resolveClient(options);

        try {
            const result = await client.deploymentHistory('GET', {
                path: `/${encodeURIComponent(historyId)}`
            });
            const data = requireHistorySuccess(result, 'Unable to read deployment history.');

            return fromSalesforceHistoryRecord(data.record);
        } catch (error) {
            const mapped = mapHistoryReadError(error);

            if (mapped === null) {
                return null;
            }

            throw mapped;
        }
    }

    async function exists(historyId) {
        return (await get(historyId)) != null;
    }

    async function update(historyId, record) {
        const client = resolveClient(options);

        try {
            const result = await client.deploymentHistory('PATCH', {
                path: `/${encodeURIComponent(historyId)}`,
                body: toSalesforceHistoryPayload(record)
            });
            const data = requireHistorySuccess(
                result,
                'Unable to update deployment history.'
            );

            return (
                fromSalesforceHistoryRecord(data.record) ||
                sanitizeHistoryRecord({
                    ...clone(record),
                    historyId,
                    salesforceRecordId: data.recordId || null
                })
            );
        } catch (error) {
            const mapped = mapHistoryReadError(error);

            if (mapped === null) {
                return null;
            }

            throw mapped;
        }
    }

    async function list() {
        const client = resolveClient(options);
        const result = await client.deploymentHistory('GET', { path: '' });
        const data = requireHistorySuccess(result, 'Unable to list deployment history.');
        const records = Array.isArray(data.records) ? data.records : [];

        return records.map((row) => fromSalesforceHistoryRecord(row)).filter(Boolean);
    }

    async function findBySnapshotId(snapshotId) {
        if (!snapshotId) {
            return null;
        }

        const client = resolveClient(options);

        try {
            const result = await client.deploymentHistory('GET', {
                path: '',
                query: { snapshotId }
            });
            const data = requireHistorySuccess(
                result,
                'Unable to find deployment history.'
            );

            return fromSalesforceHistoryRecord(data.record);
        } catch (error) {
            const mapped = mapHistoryReadError(error);

            if (mapped === null) {
                return null;
            }

            throw mapped;
        }
    }

    async function findBySalesforceDeploymentId(salesforceDeploymentId) {
        if (!salesforceDeploymentId) {
            return null;
        }

        const client = resolveClient(options);

        try {
            const result = await client.deploymentHistory('GET', {
                path: '',
                query: { salesforceDeploymentId }
            });
            const data = requireHistorySuccess(
                result,
                'Unable to find deployment history.'
            );

            return fromSalesforceHistoryRecord(data.record);
        } catch (error) {
            const mapped = mapHistoryReadError(error);

            if (mapped === null) {
                return null;
            }

            throw mapped;
        }
    }

    return {
        create,
        get,
        exists,
        update,
        list,
        findBySnapshotId,
        findBySalesforceDeploymentId
    };
}

module.exports = {
    createSalesforceControlPlaneDeploymentHistoryStore
};
