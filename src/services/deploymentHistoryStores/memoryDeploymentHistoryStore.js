'use strict';

const { HistoryDuplicateError } = require('../deploymentHistory.errors');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createMemoryDeploymentHistoryStore() {
    const records = new Map();

    function create(record) {
        const historyId = record?.historyId;

        if (!historyId) {
            throw new TypeError('historyId is required.');
        }

        if (records.has(historyId)) {
            throw new HistoryDuplicateError(historyId);
        }

        records.set(historyId, clone(record));

        return clone(record);
    }

    function get(historyId) {
        const record = records.get(historyId);

        return record ? clone(record) : null;
    }

    function exists(historyId) {
        return records.has(historyId);
    }

    function update(historyId, record) {
        if (!records.has(historyId)) {
            return null;
        }

        records.set(historyId, clone(record));

        return clone(record);
    }

    function list() {
        return [...records.values()].map((record) => clone(record));
    }

    function findBySnapshotId(snapshotId) {
        if (!snapshotId) {
            return null;
        }

        for (const record of records.values()) {
            if (record.snapshotId === snapshotId) {
                return clone(record);
            }
        }

        return null;
    }

    function findBySalesforceDeploymentId(salesforceDeploymentId) {
        if (!salesforceDeploymentId) {
            return null;
        }

        for (const record of records.values()) {
            if (
                record.salesforceDeploymentId === salesforceDeploymentId ||
                record.deploymentId === salesforceDeploymentId
            ) {
                return clone(record);
            }
        }

        return null;
    }

    function clear() {
        records.clear();
    }

    return {
        create,
        get,
        exists,
        update,
        list,
        findBySnapshotId,
        findBySalesforceDeploymentId,
        clear
    };
}

module.exports = {
    createMemoryDeploymentHistoryStore
};
