'use strict';

/**
 * Async transport for the existing rollback service.
 *
 * The rollback engine remains responsible for validation, execution,
 * terminal state transitions, and result construction.
 *
 * Salesforce-mediated async (snapshotExport + artifacts) uses the process-local
 * inline operation store. Other async clients require the shared durable store.
 *
 * Inline store limitations:
 * - Operation state is lost when the Node process restarts.
 * - Different backend instances do not share operation state.
 * - Start, execution, and polling must reach the same instance.
 */

const deploymentHistoryService = require('./deploymentHistory.service');
const {
    INPUT_CODE,
    hasSalesforceRollbackContext,
    executeRollback: defaultExecuteRollback
} = require('./deploymentRollback.service');
const {
    getSharedRollbackOperationStore,
    getSalesforceInlineRollbackOperationStore,
    UNAVAILABLE_MESSAGE
} = require('./deploymentSnapshot/rollbackOperation.resolver');
const { RollbackOperationPersistenceError } = require('./deploymentSnapshot/rollbackOperation.errors');
const {
    createRollbackOperationService,
    evaluateExistingOperations
} = require('./deploymentSnapshot/rollbackOperation.service');
const {
    ROLLBACK_OPERATION_STATUS
} = require('./deploymentSnapshot/rollbackOperation.types');
const {
    buildRollbackScopeKey
} = require('./deploymentSnapshot/rollbackOperation.scope');
const { ROLLBACK_CODE } = require('./deploymentSnapshot/snapshotRestore.errors');
const { orgIdsMatch } = require('./deploymentOrgLock/destinationOrgIdentity.service');
const { sanitizeHistoryRecord } = require('./deploymentHistory.sanitize');

const ASYNC_ERROR_CODE = 'ROLLBACK_ASYNC_ERROR';
const INCOMPLETE_SALESFORCE_CONTEXT_CODE =
    'ROLLBACK_SALESFORCE_CONTEXT_INCOMPLETE';

function text(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasPartialSalesforceRollbackContext(request = {}) {
    const hasExport = isPlainObject(request.snapshotExport);
    const hasArtifacts = isPlainObject(request.artifacts);
    return hasExport !== hasArtifacts;
}

function startRejected(code, message, httpStatus = 400) {
    return {
        httpStatus,
        body: {
            success: false,
            accepted: false,
            status: ROLLBACK_OPERATION_STATUS.FAILED,
            code,
            message,
            operationId: null
        }
    };
}

function getDefaultRollbackOperationStore() {
    return getSharedRollbackOperationStore();
}

function resolveRollbackOperationStoreForRequest(request, dependencyGetStore) {
    if (typeof dependencyGetStore === 'function') {
        return dependencyGetStore(request);
    }

    if (hasSalesforceRollbackContext(request)) {
        return getSalesforceInlineRollbackOperationStore();
    }

    return getSharedRollbackOperationStore();
}

async function resolveStoreForOperationLookup(operationId, dependencyGetStore) {
    if (typeof dependencyGetStore === 'function') {
        return dependencyGetStore();
    }

    const inlineStore = getSalesforceInlineRollbackOperationStore();
    const inlineOperation = await inlineStore.findByOperationId(operationId);
    if (inlineOperation) {
        return inlineStore;
    }

    const sharedStore = getSharedRollbackOperationStore();
    const sharedOperation = await sharedStore.findByOperationId(operationId);
    if (sharedOperation) {
        return sharedStore;
    }

    return null;
}

function createDeploymentRollbackAsyncService(dependencies = {}) {
    const executeRollback =
        dependencies.executeRollback || defaultExecuteRollback;
    const historyService =
        dependencies.historyService || deploymentHistoryService;
    const dependencyGetStore = dependencies.getStore;

    function createOperationServiceForStore(store) {
        return (
            dependencies.rollbackOperationService ||
            createRollbackOperationService({ getStore: () => store })
        );
    }

    async function validateStartRequest(request) {
        const historyId = text(request.historyId);
        const destinationOrgId = text(request.orgId);
        const history =
            historyId &&
            typeof historyService.getHistory === 'function'
                ? historyService.getHistory(historyId)
                : null;
        const snapshotId = text(request.snapshotId || history?.snapshotId);

        if (!historyId) {
            return startRejected(
                'ROLLBACK_HISTORY_ID_REQUIRED',
                'historyId is required.'
            );
        }

        if (!text(request.refreshToken) || !text(request.instanceUrl) || !destinationOrgId) {
            return startRejected(
                'ROLLBACK_DESTINATION_CREDENTIALS_REQUIRED',
                'refreshToken, instanceUrl, and orgId are required.'
            );
        }

        if (
            history?.snapshotId &&
            request.snapshotId &&
            history.snapshotId !== text(request.snapshotId)
        ) {
            return startRejected(
                'ROLLBACK_HISTORY_SNAPSHOT_MISMATCH',
                'snapshotId does not match the deployment history record.'
            );
        }

        if (!snapshotId) {
            return startRejected(
                'ROLLBACK_SNAPSHOT_ID_REQUIRED',
                'snapshotId is required.'
            );
        }

        if (
            history?.destinationOrgId &&
            !orgIdsMatch(history.destinationOrgId, destinationOrgId)
        ) {
            return startRejected(
                'ROLLBACK_HISTORY_DESTINATION_MISMATCH',
                'orgId does not match the destination org on the deployment history record.'
            );
        }

        if (hasPartialSalesforceRollbackContext(request)) {
            return startRejected(
                INCOMPLETE_SALESFORCE_CONTEXT_CODE,
                'snapshotExport and artifacts are both required for Salesforce-mediated rollback.'
            );
        }

        if (hasSalesforceRollbackContext(request)) {
            const exportSnapshotId = text(request.snapshotExport.snapshotId);

            if (!exportSnapshotId) {
                return startRejected(
                    INPUT_CODE.SNAPSHOT_ID_REQUIRED,
                    'snapshotExport.snapshotId is required.'
                );
            }

            if (exportSnapshotId !== snapshotId) {
                return startRejected(
                    INPUT_CODE.SNAPSHOT_EXPORT_MISMATCH,
                    'snapshotId does not match snapshotExport.snapshotId.'
                );
            }
        }

        return {
            request,
            historyId,
            destinationOrgId,
            snapshotId
        };
    }

    async function reserveOperation({
        request,
        destinationOrgId,
        snapshotId,
        scopeKey,
        store,
        operationService
    }) {
        return store.withExclusiveScope(scopeKey, async (previous) => {
            const records = await store.findByDestinationAndSnapshot(
                destinationOrgId,
                snapshotId
            );
            const decision = evaluateExistingOperations(records);

            if (
                decision.existing &&
                [
                    ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
                    ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                    ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                ].includes(decision.existing.status)
            ) {
                return {
                    operation: decision.existing,
                    launch: false
                };
            }

            let operation = decision.existing;
            if (
                !operation ||
                operation.status === ROLLBACK_OPERATION_STATUS.FAILED
            ) {
                operation = await operationService.createOperation({
                    destinationOrgId,
                    snapshotId,
                    rollbackOfHistoryId: text(request.historyId) || null,
                    retryOfOperationId:
                        decision.existing?.operationId || null
                });
            }

            if (operation.status === ROLLBACK_OPERATION_STATUS.NOT_STARTED) {
                operation = await operationService.transitionToInProgress(
                    operation.operationId
                );
            }

            return {
                operation,
                launch: true,
                previous
            };
        });
    }

    async function persistFinalResult(store, operationId, result) {
        await store.updateOperation(operationId, {
            finalResult: sanitizeHistoryRecord(result),
            updatedAt: new Date().toISOString()
        });
    }

    async function markAsyncFailure(store, operationService, operationId, error) {
        const message =
            error?.message || 'Unable to execute destination rollback.';
        const current = await store.findByOperationId(operationId);

        if (
            current &&
            [
                ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                ROLLBACK_OPERATION_STATUS.FAILED,
                ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
            ].includes(current.status)
        ) {
            return current;
        }

        if (
            current &&
            current.status === ROLLBACK_OPERATION_STATUS.IN_PROGRESS
        ) {
            await operationService.markTerminal(operationId, {
                status: ROLLBACK_OPERATION_STATUS.FAILED,
                resultCode: ASYNC_ERROR_CODE,
                resultMessage: message,
                errorCode: ASYNC_ERROR_CODE,
                errorMessage: message
            });
        }

        const result = {
            success: false,
            blocked: false,
            failed: true,
            unknownResult: false,
            code: ASYNC_ERROR_CODE,
            message,
            operationId,
            operationStatus: ROLLBACK_OPERATION_STATUS.FAILED
        };
        await persistFinalResult(store, operationId, result);
    }

    function createStoreAccessor(store) {
        return function rollbackOperationStoreAccessor() {
            return store;
        };
    }

    function launch(request, operationId, store, operationService) {
        const storeAccessor = createStoreAccessor(store);

        Promise.resolve()
            .then(() =>
                executeRollback({
                    ...request,
                    operationId,
                    rollbackOperationStore: storeAccessor
                })
            )
            .then(async (result) => {
                const body = result?.body || result || {};
                const finalResult = {
                    ...body,
                    operationId: body.operationId || operationId
                };
                const operation = await store.findByOperationId(operationId);
                if (
                    operation &&
                    operation.status === ROLLBACK_OPERATION_STATUS.IN_PROGRESS
                ) {
                    const status =
                        finalResult.operationStatus ||
                        (finalResult.unknownResult
                            ? ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                            : finalResult.success
                              ? ROLLBACK_OPERATION_STATUS.SUCCEEDED
                              : ROLLBACK_OPERATION_STATUS.FAILED);
                    await operationService.markTerminal(operationId, {
                        status,
                        resultCode: finalResult.code || null,
                        resultMessage: finalResult.message || null,
                        errorCode: finalResult.failed
                            ? finalResult.code || ASYNC_ERROR_CODE
                            : null,
                        errorMessage: finalResult.failed
                            ? finalResult.message || null
                            : null
                    });
                }

                const authoritative = await store.findByOperationId(operationId);
                if (
                    authoritative &&
                    [
                        ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                        ROLLBACK_OPERATION_STATUS.FAILED,
                        ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                    ].includes(authoritative.status) &&
                    !authoritative.finalResult
                ) {
                    await persistFinalResult(store, operationId, finalResult);
                }
            })
            .catch((error) => {
                void markAsyncFailure(
                    store,
                    operationService,
                    operationId,
                    error
                ).catch((persistError) => {
                    console.error('ASYNC ROLLBACK ERROR PERSISTENCE ERROR');
                    console.error(persistError);
                });
            });
    }

    async function startRollback(request = {}) {
        const validated = await validateStartRequest(request);
        if (validated.httpStatus) {
            return validated;
        }

        const store = resolveRollbackOperationStoreForRequest(
            validated.request,
            dependencyGetStore
        );
        const operationService = createOperationServiceForStore(store);

        const scopeKey = buildRollbackScopeKey(
            validated.destinationOrgId,
            validated.snapshotId
        );

        let reservation;

        try {
            reservation = await reserveOperation({
                request: validated.request,
                destinationOrgId: validated.destinationOrgId,
                snapshotId: validated.snapshotId,
                scopeKey,
                store,
                operationService
            });
        } catch (error) {
            const persistenceFailure =
                error instanceof RollbackOperationPersistenceError ||
                error?.code === 'ROLLBACK_OPERATION_PERSISTENCE';

            if (persistenceFailure) {
                return startRejected(
                    ROLLBACK_CODE.OPERATION_STORE_UNAVAILABLE,
                    error.message || UNAVAILABLE_MESSAGE,
                    503
                );
            }

            throw error;
        }

        if (!reservation.launch) {
            const code =
                reservation.operation.status ===
                ROLLBACK_OPERATION_STATUS.IN_PROGRESS
                    ? ROLLBACK_CODE.ALREADY_IN_PROGRESS
                    : reservation.operation.status ===
                        ROLLBACK_OPERATION_STATUS.SUCCEEDED
                      ? ROLLBACK_CODE.ALREADY_COMPLETED
                      : ROLLBACK_CODE.RESULT_UNKNOWN;

            return {
                success: reservation.operation.status ===
                    ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
                accepted: reservation.operation.status ===
                    ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
                status: reservation.operation.status,
                operationId: reservation.operation.operationId,
                code,
                message:
                    reservation.operation.status ===
                    ROLLBACK_OPERATION_STATUS.IN_PROGRESS
                        ? 'A rollback for this snapshot is already in progress.'
                        : reservation.operation.status ===
                            ROLLBACK_OPERATION_STATUS.SUCCEEDED
                          ? 'A rollback for this snapshot already completed successfully.'
                          : 'A prior rollback for this snapshot has an unknown Salesforce result and must be reconciled before retry.'
            };
        }

        launch(
            validated.request,
            reservation.operation.operationId,
            store,
            operationService
        );

        return {
            success: true,
            accepted: true,
            status: ROLLBACK_OPERATION_STATUS.IN_PROGRESS,
            operationId: reservation.operation.operationId
        };
    }

    async function getRollbackStatus(operationId) {
        const normalizedId = text(operationId);
        if (!normalizedId) {
            return { found: false };
        }

        const store = await resolveStoreForOperationLookup(
            normalizedId,
            dependencyGetStore
        );
        if (!store) {
            return { found: false };
        }

        const operation = await store.findByOperationId(normalizedId);
        if (!operation) {
            return { found: false };
        }

        const result = operation.finalResult || null;
        const terminal = [
            ROLLBACK_OPERATION_STATUS.SUCCEEDED,
            ROLLBACK_OPERATION_STATUS.FAILED,
            ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
        ].includes(operation.status);

        const body = {
            success:
                operation.status === ROLLBACK_OPERATION_STATUS.SUCCEEDED ||
                (!terminal && operation.status === ROLLBACK_OPERATION_STATUS.IN_PROGRESS),
            status: operation.status,
            operationId: normalizedId
        };

        if (result !== null) {
            body.result = result;
        }

        if (terminal && operation.resultCode) {
            body.resultCode = operation.resultCode;
        }
        if (terminal && operation.errorMessage) {
            body.error = operation.errorMessage;
        }

        return { found: true, body };
    }

    return {
        startRollback,
        getRollbackStatus
    };
}

const defaultService = createDeploymentRollbackAsyncService();

module.exports = {
    ASYNC_ERROR_CODE,
    INCOMPLETE_SALESFORCE_CONTEXT_CODE,
    createDeploymentRollbackAsyncService,
    getDefaultRollbackOperationStore,
    hasPartialSalesforceRollbackContext,
    resolveRollbackOperationStoreForRequest,
    resolveStoreForOperationLookup,
    startRollback: defaultService.startRollback,
    getRollbackStatus: defaultService.getRollbackStatus
};