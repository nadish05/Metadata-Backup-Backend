'use strict';

const crypto = require('crypto');

const { sanitizeHistoryRecord } = require('../deploymentHistory.sanitize');
const {
    RollbackOperationPersistenceError,
    RollbackOperationStateError,
    RollbackOperationScopeBusyError,
    RollbackOperationScopeAmbiguousError
} = require('./rollbackOperation.errors');
const { logRollbackOperationEvent } = require('./rollbackOperation.log');
const { getSharedRollbackOperationStore } = require('./rollbackOperation.resolver');
const {
    buildRollbackScopeKey,
    evaluateExistingOperation,
    evaluateExistingOperations
} = require('./rollbackOperation.scope');
const {
    CHECK_ONLY_STATUS,
    ROLLBACK_OPERATION_SCHEMA_VERSION,
    ROLLBACK_OPERATION_STATUS,
    ROLLBACK_OPERATION_TYPE
} = require('./rollbackOperation.types');

const AUTOMATIC_TRANSITIONS = Object.freeze({
    [ROLLBACK_OPERATION_STATUS.NOT_STARTED]: [
        ROLLBACK_OPERATION_STATUS.IN_PROGRESS
    ],
    [ROLLBACK_OPERATION_STATUS.IN_PROGRESS]: [
        ROLLBACK_OPERATION_STATUS.SUCCEEDED,
        ROLLBACK_OPERATION_STATUS.FAILED,
        ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
    ]
});

function nowIso() {
    return new Date().toISOString();
}

function generateOperationId() {
    return `rbo-${crypto.randomBytes(8).toString('hex')}`;
}

function sanitizeOperation(record) {
    return sanitizeHistoryRecord(record);
}

function assertAutomaticTransition(fromStatus, toStatus) {
    const allowed = AUTOMATIC_TRANSITIONS[fromStatus] || [];

    if (!allowed.includes(toStatus)) {
        throw new RollbackOperationStateError(
            `Invalid rollback operation transition: ${fromStatus} -> ${toStatus}`
        );
    }
}

function classifyExecutionResult(mappedResult) {
    if (!mappedResult) {
        return { status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT };
    }

    const status = String(mappedResult.status || '').toUpperCase();
    const componentFailures = Array.isArray(mappedResult.componentFailures)
        ? mappedResult.componentFailures
        : Array.isArray(mappedResult.deploymentDiagnostics?.componentFailures)
          ? mappedResult.deploymentDiagnostics.componentFailures
          : [];

    if (
        mappedResult.success === true &&
        ['SUCCESS', 'SUCCEEDED'].includes(status) &&
        componentFailures.length === 0
    ) {
        return { status: ROLLBACK_OPERATION_STATUS.SUCCEEDED };
    }

    if (
        mappedResult.success === false &&
        ['FAILED', 'ERROR', 'BLOCKED'].includes(status)
    ) {
        return { status: ROLLBACK_OPERATION_STATUS.FAILED };
    }

    return { status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT };
}

function classifyExecutionException(error, executionStarted) {
    if (!executionStarted) {
        return {
            status: ROLLBACK_OPERATION_STATUS.FAILED,
            errorCode: error?.code || 'ROLLBACK_EXECUTION_FAILED',
            errorMessage:
                error?.message ||
                'Rollback execution failed before Salesforce mutation.'
        };
    }

    return {
        status: ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT,
        errorCode: 'ROLLBACK_RESULT_UNKNOWN',
        errorMessage:
            error?.message ||
            'Salesforce rollback execution outcome cannot be determined.'
    };
}

function createRollbackOperationService({ getStore } = {}) {
    const resolveStore = getStore || getSharedRollbackOperationStore;

    async function persist(operationId, patch, options) {
        return resolveStore().updateOperation(
            operationId,
            sanitizeOperation(patch),
            options
        );
    }

    async function findLatestForSnapshot(destinationOrgId, snapshotId) {
        const records = await resolveStore().findByDestinationAndSnapshot(
            destinationOrgId,
            snapshotId
        );
        const decision = evaluateExistingOperations(records);

        return decision.existing || null;
    }

    async function findOperationsForSnapshot(destinationOrgId, snapshotId) {
        return resolveStore().findByDestinationAndSnapshot(
            destinationOrgId,
            snapshotId
        );
    }

    function buildScopeRecord(rollbackScopeKey, input, operation, previous, records) {
        const operationIds = [
            ...((previous && previous.operationIds) || []),
            ...(records || []).map((record) => record.operationId),
            operation.operationId
        ].filter(Boolean);

        return {
            schemaVersion: 1,
            rollbackScopeKey,
            destinationOrgId: input.destinationOrgId,
            snapshotId: input.snapshotId,
            activeOperationId: operation.operationId,
            operationIds: [...new Set(operationIds)],
            status: operation.status,
            updatedAt: nowIso()
        };
    }

    async function createOperation(input) {
        const createdAt = nowIso();
        const rollbackScopeKey = buildRollbackScopeKey(
            input.destinationOrgId,
            input.snapshotId
        );
        const record = sanitizeOperation({
            schemaVersion: ROLLBACK_OPERATION_SCHEMA_VERSION,
            operationId: input.operationId || generateOperationId(),
            operationType: ROLLBACK_OPERATION_TYPE,
            snapshotId: input.snapshotId,
            rollbackScopeKey,
            rollbackOfHistoryId: input.rollbackOfHistoryId || null,
            retryOfOperationId: input.retryOfOperationId || null,
            destinationOrgId: input.destinationOrgId,
            sourceDeploymentId: input.sourceDeploymentId || null,
            status: ROLLBACK_OPERATION_STATUS.NOT_STARTED,
            createdAt,
            startedAt: null,
            completedAt: null,
            updatedAt: createdAt,
            executionStartedAt: null,
            salesforceDeploymentId: null,
            salesforceStatus: null,
            resultCode: null,
            resultMessage: null,
            success: null,
            errorCode: null,
            errorMessage: null,
            driftDetected: false,
            driftSummary: null,
            checkOnlyStatus: CHECK_ONLY_STATUS.PENDING,
            lockOwner: null,
            leaseGeneration: null,
            lockAcquiredAt: null,
            lockReleasedAt: null,
            reconciledAt: null,
            reconciledBy: null,
            reconciliationReason: null
        });

        const stored = await resolveStore().createOperation(record);

        logRollbackOperationEvent(
            input.retryOfOperationId
                ? 'ROLLBACK_OPERATION_RETRY_CREATED'
                : 'ROLLBACK_OPERATION_CREATED',
            stored
        );

        return stored;
    }

    async function claimOperation(input, attempt = 0) {
        const rollbackScopeKey = buildRollbackScopeKey(
            input.destinationOrgId,
            input.snapshotId
        );
        const store = resolveStore();

        async function decideAndMaybeCreate(previousScope) {
            const records = await store.findByDestinationAndSnapshot(
                input.destinationOrgId,
                input.snapshotId
            );
            const decision = evaluateExistingOperations(records);

            if (
                decision.action === 'BLOCK_COMPLETED' ||
                decision.action === 'BLOCK_UNKNOWN' ||
                decision.action === 'BLOCK_IN_PROGRESS'
            ) {
                return {
                    decision,
                    operation: decision.existing,
                    scope:
                        decision.existing && !previousScope
                            ? buildScopeRecord(
                                  rollbackScopeKey,
                                  input,
                                  decision.existing,
                                  previousScope,
                                  records
                              )
                            : undefined
                };
            }

            let operation = decision.existing;

            if (decision.action !== 'RESUME') {
                operation = await createOperation({
                    ...input,
                    rollbackOfHistoryId: input.rollbackOfHistoryId || null,
                    retryOfOperationId:
                        decision.action === 'RETRY'
                            ? decision.existing?.operationId
                            : null
                });
            }

            operation = await transitionToInProgress(operation.operationId);

            return {
                decision,
                operation,
                scope: buildScopeRecord(
                    rollbackScopeKey,
                    input,
                    operation,
                    previousScope,
                    records
                )
            };
        }

        try {
            return await store.withExclusiveScope(
                rollbackScopeKey,
                decideAndMaybeCreate
            );
        } catch (error) {
            if (!(error instanceof RollbackOperationScopeBusyError)) {
                throw error;
            }

            const records = await store.findByDestinationAndSnapshot(
                input.destinationOrgId,
                input.snapshotId
            );
            const decision = evaluateExistingOperations(records);

            if (decision.action !== 'CREATE') {
                return {
                    decision,
                    operation: decision.existing
                };
            }

            if (attempt >= 25) {
                throw new RollbackOperationScopeAmbiguousError(
                    'Rollback scope is busy and no durable operation could be confirmed.'
                );
            }

            await new Promise((resolve) => setTimeout(resolve, 20));

            return claimOperation(input, attempt + 1);
        }
    }

    async function transitionToInProgress(operationId) {
        const current = await resolveStore().getOperation(operationId);

        if (!current) {
            throw new RollbackOperationStateError(
                `Rollback operation not found: ${operationId}`
            );
        }

        assertAutomaticTransition(
            current.status,
            ROLLBACK_OPERATION_STATUS.IN_PROGRESS
        );

        const next = await persist(operationId, {
            status: ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
            startedAt: current.startedAt || nowIso(),
            updatedAt: nowIso()
        });

        logRollbackOperationEvent('ROLLBACK_OPERATION_IN_PROGRESS', next);

        return next;
    }

    async function markExecutionStarted(operationId) {
        return persist(operationId, {
            executionStartedAt: nowIso(),
            updatedAt: nowIso()
        });
    }

    async function markTerminal(operationId, outcome) {
        const current = await resolveStore().getOperation(operationId);

        if (!current) {
            throw new RollbackOperationStateError(
                `Rollback operation not found: ${operationId}`
            );
        }

        assertAutomaticTransition(current.status, outcome.status);

        const next = await persist(operationId, {
            status: outcome.status,
            completedAt: nowIso(),
            updatedAt: nowIso(),
            salesforceDeploymentId:
                outcome.salesforceDeploymentId || current.salesforceDeploymentId,
            salesforceStatus: outcome.salesforceStatus || current.salesforceStatus,
            resultCode: outcome.resultCode || null,
            resultMessage: outcome.resultMessage || null,
            success: outcome.status === ROLLBACK_OPERATION_STATUS.SUCCEEDED,
            errorCode: outcome.errorCode || null,
            errorMessage: outcome.errorMessage || null,
            driftDetected: Boolean(outcome.driftDetected || current.driftDetected),
            driftSummary: outcome.driftSummary || current.driftSummary || null,
            checkOnlyStatus: outcome.checkOnlyStatus || current.checkOnlyStatus,
            lockOwner: outcome.lockOwner || current.lockOwner,
            leaseGeneration:
                outcome.leaseGeneration ?? current.leaseGeneration,
            lockAcquiredAt: outcome.lockAcquiredAt || current.lockAcquiredAt,
            lockReleasedAt: outcome.lockReleasedAt || current.lockReleasedAt
        });

        if (outcome.status === ROLLBACK_OPERATION_STATUS.SUCCEEDED) {
            logRollbackOperationEvent('ROLLBACK_OPERATION_SUCCEEDED', next);
        } else if (outcome.status === ROLLBACK_OPERATION_STATUS.FAILED) {
            logRollbackOperationEvent('ROLLBACK_OPERATION_FAILED', next);
        } else {
            logRollbackOperationEvent('ROLLBACK_OPERATION_UNKNOWN', next);
        }

        return next;
    }

    async function recoverAbandonedInProgress(operation) {
        if (
            !operation ||
            operation.status !== ROLLBACK_OPERATION_STATUS.IN_PROGRESS
        ) {
            return operation;
        }

        const recoveredStatus = operation.executionStartedAt
            ? ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
            : ROLLBACK_OPERATION_STATUS.FAILED;

        return markTerminal(operation.operationId, {
            status: recoveredStatus,
            errorCode: operation.executionStartedAt
                ? 'ROLLBACK_RESULT_UNKNOWN'
                : 'ROLLBACK_INTERRUPTED_BEFORE_EXECUTION',
            errorMessage: operation.executionStartedAt
                ? 'Process restarted after Salesforce execution may have started.'
                : 'Process restarted before Salesforce execution started.'
        });
    }

    async function reconcileUnknownOperation({
        operationId,
        salesforceDeploymentId,
        salesforceStatus,
        actor,
        reason
    } = {}) {
        const current = await resolveStore().getOperation(operationId);

        if (!current) {
            throw new RollbackOperationStateError(
                `Rollback operation not found: ${operationId}`
            );
        }

        if (current.status !== ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT) {
            throw new RollbackOperationStateError(
                'Only UNKNOWN_RESULT operations can be reconciled.'
            );
        }

        const status = String(salesforceStatus || '').toUpperCase();
        let nextStatus = ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT;

        if (['SUCCESS', 'SUCCEEDED'].includes(status) && salesforceDeploymentId) {
            nextStatus = ROLLBACK_OPERATION_STATUS.SUCCEEDED;
        } else if (
            ['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(status)
        ) {
            nextStatus = ROLLBACK_OPERATION_STATUS.FAILED;
        }

        if (nextStatus === ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT) {
            return current;
        }

        const next = await persist(
            operationId,
            {
                status: nextStatus,
                completedAt: nowIso(),
                updatedAt: nowIso(),
                salesforceDeploymentId:
                    salesforceDeploymentId || current.salesforceDeploymentId,
                salesforceStatus: status,
                success: nextStatus === ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                reconciledAt: nowIso(),
                reconciledBy: actor || 'operator',
                reconciliationReason: reason || null
            },
            { allowReconciliation: true }
        );

        logRollbackOperationEvent('ROLLBACK_OPERATION_RECONCILED', {
            ...next,
            actor: actor || 'operator',
            reason: reason || null
        });

        return next;
    }

    return {
        findLatestForSnapshot,
        findOperationsForSnapshot,
        evaluateExistingOperation,
        evaluateExistingOperations,
        createOperation,
        claimOperation,
        transitionToInProgress,
        markExecutionStarted,
        markTerminal,
        recoverAbandonedInProgress,
        reconcileUnknownOperation,
        classifyExecutionResult,
        classifyExecutionException
    };
}

module.exports = {
    AUTOMATIC_TRANSITIONS,
    classifyExecutionException,
    classifyExecutionResult,
    createRollbackOperationService,
    evaluateExistingOperation,
    evaluateExistingOperations,
    generateOperationId,
    RollbackOperationPersistenceError
};
