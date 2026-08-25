'use strict';

const {
    RollbackOperationNotFoundError,
    RollbackOperationStateError
} = require('../rollbackOperation.errors');
const {
    TERMINAL_ROLLBACK_OPERATION_STATUSES
} = require('../rollbackOperation.types');
const { parseRollbackScopeKey } = require('../rollbackOperation.scope');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createMemoryRollbackOperationStore() {
    const records = new Map();
    const scopes = new Map();
    const scopeTails = new Map();

    async function createOperation(record) {
        if (!record?.operationId) {
            throw new RollbackOperationStateError('operationId is required.');
        }

        if (records.has(record.operationId)) {
            throw new RollbackOperationStateError(
                `Rollback operation already exists: ${record.operationId}`
            );
        }

        const stored = clone(record);
        records.set(stored.operationId, stored);

        return clone(stored);
    }

    async function getOperation(operationId) {
        const stored = records.get(operationId);

        return stored ? clone(stored) : null;
    }

    async function updateOperation(operationId, patch = {}, options = {}) {
        const stored = records.get(operationId);

        if (!stored) {
            throw new RollbackOperationNotFoundError(operationId);
        }

        const terminal = TERMINAL_ROLLBACK_OPERATION_STATUSES.includes(
            stored.status
        );

        if (
            terminal &&
            patch.status &&
            patch.status !== stored.status &&
            !options.allowReconciliation
        ) {
            throw new RollbackOperationStateError(
                `Terminal rollback operation cannot be mutated: ${operationId}`
            );
        }

        Object.assign(stored, patch);

        return clone(stored);
    }

    async function list() {
        return [...records.values()].map(clone);
    }

    async function findByOperationId(operationId) {
        return getOperation(operationId);
    }

    async function findBySnapshotId(snapshotId) {
        if (!snapshotId) {
            return [];
        }

        return (await list()).filter((record) => record.snapshotId === snapshotId);
    }

    async function findBySalesforceDeploymentId(salesforceDeploymentId) {
        if (!salesforceDeploymentId) {
            return [];
        }

        return (await list()).filter(
            (record) => record.salesforceDeploymentId === salesforceDeploymentId
        );
    }

    async function findByDestinationAndSnapshot(destinationOrgId, snapshotId) {
        return (await list()).filter(
            (record) =>
                record.destinationOrgId === destinationOrgId &&
                record.snapshotId === snapshotId
        );
    }

    async function getScope(rollbackScopeKey) {
        parseRollbackScopeKey(rollbackScopeKey);
        const stored = scopes.get(rollbackScopeKey);

        return stored ? clone(stored) : null;
    }

    async function withExclusiveScope(rollbackScopeKey, worker) {
        parseRollbackScopeKey(rollbackScopeKey);

        const previous = scopeTails.get(rollbackScopeKey) || Promise.resolve();
        let release = () => {};
        const held = new Promise((resolve) => {
            release = resolve;
        });

        scopeTails.set(
            rollbackScopeKey,
            previous.then(() => held).catch(() => held)
        );

        await previous.catch(() => {});

        try {
            const current = scopes.get(rollbackScopeKey) || null;
            const result = await worker(current ? clone(current) : null);

            if (result && result.scope) {
                scopes.set(rollbackScopeKey, clone(result.scope));
            }

            return result;
        } finally {
            release();
        }
    }

    return {
        createOperation,
        getOperation,
        updateOperation,
        findBySnapshotId,
        findByOperationId,
        findBySalesforceDeploymentId,
        findByDestinationAndSnapshot,
        getScope,
        withExclusiveScope
    };
}

module.exports = {
    createMemoryRollbackOperationStore
};
