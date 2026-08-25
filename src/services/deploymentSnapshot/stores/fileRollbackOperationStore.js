'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const {
    assertSafeStorageKey,
    pathExists,
    atomicWrite
} = require('../../../utils/durableFileStore');
const {
    RollbackOperationNotFoundError,
    RollbackOperationPersistenceError,
    RollbackOperationSchemaError,
    RollbackOperationStateError
} = require('../rollbackOperation.errors');
const {
    ROLLBACK_OPERATION_SCHEMA_VERSION,
    TERMINAL_ROLLBACK_OPERATION_STATUSES
} = require('../rollbackOperation.types');

const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createFileRollbackOperationStore({ rootDir } = {}) {
    if (!rootDir) {
        throw new RollbackOperationPersistenceError(
            'SNAPSHOT_DURABLE_ROOT is required for filesystem rollback operation storage.'
        );
    }

    const operationsRoot = path.join(rootDir, 'rollback-operations');

    function operationFile(operationId) {
        assertSafeStorageKey(operationId, 'operationId');

        return path.join(operationsRoot, `${operationId}.json`);
    }

    async function readRecord(operationId) {
        const filePath = operationFile(operationId);

        if (!(await pathExists(filePath))) {
            return null;
        }

        try {
            const parsed = JSON.parse(await readFile(filePath, 'utf8'));

            if (
                parsed.schemaVersion &&
                parsed.schemaVersion !== ROLLBACK_OPERATION_SCHEMA_VERSION
            ) {
                throw new RollbackOperationSchemaError(
                    `Unsupported rollback operation schemaVersion: ${parsed.schemaVersion}`
                );
            }

            return parsed;
        } catch (error) {
            if (error instanceof RollbackOperationSchemaError) {
                throw error;
            }

            throw new RollbackOperationPersistenceError(
                `Rollback operation record is unreadable: ${operationId}`
            );
        }
    }

    async function createOperation(record) {
        if (!record?.operationId) {
            throw new RollbackOperationStateError('operationId is required.');
        }

        const filePath = operationFile(record.operationId);
        const stored = clone(record);

        try {
            await atomicWrite(filePath, JSON.stringify(stored, null, 2), {
                exclusive: true
            });
        } catch (error) {
            if (error && error.code === 'EEXIST') {
                throw new RollbackOperationStateError(
                    `Rollback operation already exists: ${record.operationId}`
                );
            }

            throw error;
        }

        return clone(stored);
    }

    async function getOperation(operationId) {
        const stored = await readRecord(operationId);

        return stored ? clone(stored) : null;
    }

    async function updateOperation(operationId, patch = {}, options = {}) {
        const stored = await readRecord(operationId);

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
        await atomicWrite(
            operationFile(operationId),
            JSON.stringify(stored, null, 2)
        );

        return clone(stored);
    }

    async function list() {
        if (!(await pathExists(operationsRoot))) {
            return [];
        }

        const names = (await readdir(operationsRoot)).filter(
            (name) => name.endsWith('.json') && !name.includes('.tmp')
        );
        const records = [];

        for (const name of names) {
            const operationId = name.replace(/\.json$/, '');

            try {
                const record = await readRecord(operationId);

                if (record) {
                    records.push(clone(record));
                }
            } catch (error) {
                console.error('ROLLBACK_OPERATION_UNREADABLE');
                console.error(
                    JSON.stringify({
                        operationId,
                        reason: error.message || 'unreadable'
                    })
                );
            }
        }

        return records;
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

    return {
        createOperation,
        getOperation,
        updateOperation,
        findBySnapshotId,
        findByOperationId,
        findBySalesforceDeploymentId,
        findByDestinationAndSnapshot
    };
}

module.exports = {
    createFileRollbackOperationStore
};
