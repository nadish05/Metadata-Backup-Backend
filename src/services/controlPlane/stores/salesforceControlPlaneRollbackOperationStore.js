'use strict';

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('../controlPlane.errors');
const { createAuthUnavailableError } = require('../controlPlane.auth');
const { MISSING_CONTROL_PLANE_ENDPOINTS } = require('../controlPlane.missingEndpoints');
const {
    canOverwriteStatus,
    fromSalesforceOperation,
    isTerminalStatus,
    toSalesforceOperationCreatePayload,
    toSalesforceOperationPatchPayload,
    ROLLBACK_OPERATION_STATUS
} = require('../controlPlane.operationMapping');
const {
    parseNodeRollbackScopeKey
} = require('../controlPlane.scopeKey');

function resolveClient(options = {}) {
    if (options.client) {
        return options.client;
    }

    if (typeof options.getClient === 'function') {
        return options.getClient();
    }

    throw createAuthUnavailableError();
}

function encodePath(value) {
    return encodeURIComponent(String(value));
}

function mapOperationError(error, operationId) {
    if (
        error instanceof ControlPlaneError &&
        error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
    ) {
        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND,
            `Rollback operation not found: ${operationId}`
        );
    }

    if (
        error instanceof ControlPlaneError &&
        error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT
    ) {
        if (error.field === 'Rollback_Scope_Key__c') {
            return new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT,
                'Duplicate rollback scope rejected.',
                { field: error.field, salesforceCode: error.salesforceCode }
            );
        }

        if (error.field === 'Operation_Id__c') {
            return new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT,
                `Rollback operation already exists: ${operationId}`,
                { field: error.field, salesforceCode: error.salesforceCode }
            );
        }

        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT,
            error.message || 'Rollback operation conflict.',
            { field: error.field, salesforceCode: error.salesforceCode }
        );
    }

    return error;
}

function createSalesforceControlPlaneRollbackOperationStore(options = {}) {
    const scopeTails = new Map();

    async function createOperation(record) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane('POST', '/operations', {
                body: toSalesforceOperationCreatePayload(record)
            });

            return fromSalesforceOperation(envelope.record);
        } catch (error) {
            throw mapOperationError(error, record?.operationId);
        }
    }

    async function getOperation(operationId) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'GET',
                `/operations/${encodePath(operationId)}`
            );

            return fromSalesforceOperation(envelope.record);
        } catch (error) {
            if (
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
            ) {
                return null;
            }

            throw mapOperationError(error, operationId);
        }
    }

    async function updateOperation(operationId, patch = {}, storeOptions = {}) {
        const current = await getOperation(operationId);

        if (!current) {
            throw new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND,
                `Rollback operation not found: ${operationId}`
            );
        }

        if (patch.status && patch.status !== current.status) {
            if (
                !canOverwriteStatus(current.status, patch.status, storeOptions)
            ) {
                throw new ControlPlaneError(
                    CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT,
                    `Status transition rejected: ${current.status} -> ${patch.status}`
                );
            }

            if (
                storeOptions.allowReconciliation &&
                current.status === ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
            ) {
                throw new ControlPlaneError(
                    CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
                    'Salesforce ControlPlaneApi cannot reconcile UNKNOWN_RESULT to a new terminal status.'
                );
            }
        }

        const client = resolveClient(options);

        try {
            if (
                patch.status === ROLLBACK_OPERATION_STATUS.IN_PROGRESS &&
                current.status === ROLLBACK_OPERATION_STATUS.NOT_STARTED
            ) {
                const claimed = await client.controlPlane(
                    'POST',
                    `/operations/${encodePath(operationId)}/in-progress`
                );

                return fromSalesforceOperation(claimed.record);
            }

            if (
                patch.status &&
                isTerminalStatus(patch.status) &&
                patch.status !== current.status
            ) {
                const terminal = await client.controlPlane(
                    'POST',
                    `/operations/${encodePath(operationId)}/terminal`,
                    {
                        body: {
                            status: patch.status,
                            resultCode: patch.resultCode || null,
                            resultMessage: patch.resultMessage || null
                        }
                    }
                );

                return fromSalesforceOperation(terminal.record);
            }

            if (
                Object.prototype.hasOwnProperty.call(patch, 'executionStartedAt') &&
                patch.executionStartedAt &&
                !current.executionStartedAt
            ) {
                const started = await client.controlPlane(
                    'POST',
                    `/operations/${encodePath(operationId)}/execution-started`
                );

                return fromSalesforceOperation(started.record);
            }

            const envelope = await client.controlPlane(
                'PATCH',
                `/operations/${encodePath(operationId)}`,
                { body: toSalesforceOperationPatchPayload(patch) }
            );

            return fromSalesforceOperation(envelope.record);
        } catch (error) {
            throw mapOperationError(error, operationId);
        }
    }

    async function findByDestinationAndSnapshot(destinationOrgId, snapshotId) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane('GET', '/operations', {
                query: {
                    destinationOrgId,
                    snapshotId
                }
            });

            return [fromSalesforceOperation(envelope.record)];
        } catch (error) {
            if (
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
            ) {
                return [];
            }

            throw error;
        }
    }

    async function findByOperationId(operationId) {
        return getOperation(operationId);
    }

    async function findBySnapshotId() {
        resolveClient(options);
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
            MISSING_CONTROL_PLANE_ENDPOINTS.operationListBySnapshot
        );
    }

    async function findBySalesforceDeploymentId() {
        resolveClient(options);
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
            MISSING_CONTROL_PLANE_ENDPOINTS.operationListBySalesforceDeploymentId
        );
    }

    async function getScope(rollbackScopeKey) {
        const parsed = parseNodeRollbackScopeKey(rollbackScopeKey);
        const records = await findByDestinationAndSnapshot(
            parsed.destinationOrgId,
            parsed.snapshotId
        );
        const existing = records[0];

        if (!existing) {
            return null;
        }

        return {
            schemaVersion: 1,
            rollbackScopeKey,
            destinationOrgId: parsed.destinationOrgId,
            snapshotId: parsed.snapshotId,
            activeOperationId: existing.operationId,
            operationIds: [existing.operationId],
            status: existing.status,
            updatedAt: existing.updatedAt
        };
    }

    async function withExclusiveScope(rollbackScopeKey, worker) {
        parseNodeRollbackScopeKey(rollbackScopeKey);

        const previous = scopeTails.get(rollbackScopeKey) || Promise.resolve();
        let release = () => {};
        const held = new Promise((resolve) => {
            release = resolve;
        });

        scopeTails.set(
            rollbackScopeKey,
            previous.then(() => held).catch(() => held)
        );

        try {
            await previous;
        } catch (error) {
            void error;
        }

        try {
            const current = await getScope(rollbackScopeKey);
            return await worker(current);
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
    createSalesforceControlPlaneRollbackOperationStore
};
