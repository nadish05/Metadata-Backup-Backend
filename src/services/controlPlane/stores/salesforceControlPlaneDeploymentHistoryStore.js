'use strict';

const { sanitizeHistoryRecord } = require('../../deploymentHistory.sanitize');
const { HistoryDuplicateError } = require('../../deploymentHistory.errors');
const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('../controlPlane.errors');
const { createAuthUnavailableError } = require('../controlPlane.auth');
const { toSalesforceHistoryPayload } = require('../controlPlane.historyMapping');
const { MISSING_CONTROL_PLANE_ENDPOINTS } = require('../controlPlane.missingEndpoints');

function resolveClient(options = {}) {
    if (options.client) {
        return options.client;
    }

    if (typeof options.getClient === 'function') {
        return options.getClient();
    }

    throw createAuthUnavailableError();
}

function missingHistoryEndpoint(endpointKey) {
    return new ControlPlaneError(
        CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
        MISSING_CONTROL_PLANE_ENDPOINTS[endpointKey]
    );
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
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

    async function get() {
        resolveClient(options);
        throw missingHistoryEndpoint('historyGet');
    }

    async function exists() {
        resolveClient(options);
        throw missingHistoryEndpoint('historyGet');
    }

    async function update() {
        resolveClient(options);
        throw missingHistoryEndpoint('historyUpdate');
    }

    async function list() {
        resolveClient(options);
        throw missingHistoryEndpoint('historyList');
    }

    async function findBySnapshotId() {
        resolveClient(options);
        throw missingHistoryEndpoint('historyList');
    }

    async function findBySalesforceDeploymentId() {
        resolveClient(options);
        throw missingHistoryEndpoint('historyList');
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
