'use strict';

/**
 * Async transport for the existing rollback service.
 *
 * The rollback engine remains responsible for validation, execution,
 * terminal state transitions, and result construction.
 */

const deploymentRollbackService = require('./deploymentRollback.service');
const deploymentHistoryService = require('./deploymentHistory.service');
const {
    getSharedRollbackOperationStore
} = require('./deploymentSnapshot/rollbackOperation.resolver');
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

function text(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function startRejected(code, message) {
    return {
        httpStatus: 400,
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

function createDeploymentRollbackAsyncService(dependencies = {}) {
    const executeRollback =
        dependencies.executeRollback ||
        deploymentRollbackService.executeRollback;
    const historyService =
        dependencies.historyService || deploymentHistoryService;
    const resolveStore =
        dependencies.getStore || getSharedRollbackOperationStore;
    const operationService =
        dependencies.rollbackOperationService ||
        createRollbackOperationService({ getStore: resolveStore });

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
        scopeKey
    }) {
        return resolveStore().withExclusiveScope(scopeKey, async (previous) => {
            const store = resolveStore();
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

    async function persistFinalResult(operationId, result) {
        await resolveStore().updateOperation(operationId, {
            finalResult: sanitizeHistoryRecord(result),
            updatedAt: new Date().toISOString()
        });
    }

    async function markAsyncFailure(operationId, error) {
        const message =
            error?.message || 'Unable to execute destination rollback.';
        const current = await resolveStore().findByOperationId(operationId);

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
        await persistFinalResult(operationId, result);
    }

    function launch(request, operationId) {
        Promise.resolve()
            .then(() =>
                executeRollback({
                    ...request,
                    operationId,
                    rollbackOperationStore: resolveStore
                })
            )
            .then(async (result) => {
                const body = result?.body || result || {};
                const finalResult = {
                    ...body,
                    operationId: body.operationId || operationId
                };
                const operation = await resolveStore().findByOperationId(operationId);
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

            const authoritative = await resolveStore().findByOperationId(
                operationId
            );
            if (
                authoritative &&
                [
                    ROLLBACK_OPERATION_STATUS.SUCCEEDED,
                    ROLLBACK_OPERATION_STATUS.FAILED,
                    ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
                ].includes(authoritative.status) &&
                !authoritative.finalResult
            ) {
                await persistFinalResult(operationId, finalResult);
            }
            })
            .catch((error) => {
                void markAsyncFailure(operationId, error).catch((persistError) => {
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

        const scopeKey = buildRollbackScopeKey(
            validated.destinationOrgId,
            validated.snapshotId
        );
        const reservation = await reserveOperation({
            request,
            destinationOrgId: validated.destinationOrgId,
            snapshotId: validated.snapshotId,
            scopeKey
        });

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

        launch(request, reservation.operation.operationId);

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

        const operation = await resolveStore().findByOperationId(normalizedId);
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
    createDeploymentRollbackAsyncService,
    startRollback: defaultService.startRollback,
    getRollbackStatus: defaultService.getRollbackStatus
};
