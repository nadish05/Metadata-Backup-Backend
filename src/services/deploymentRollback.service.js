'use strict';

/**
 * HTTP adapter for CASE-B (MODIFIED-only) rollback.
 * Reuses destinationSnapshotRestore.runRollback(). Does not enable
 * SNAPSHOT_ROLLBACK_ENABLED, expand allowlists, or add destructive deletes.
 */

const {
    createDestinationSnapshotRestoreService
} = require('./deploymentSnapshot/destinationSnapshotRestore.service');
const { ROLLBACK_CODE } = require('./deploymentSnapshot/snapshotRestore.errors');
const { ROLLBACK_OPERATION_STATUS } = require('./deploymentSnapshot/rollbackOperation.types');
const {
    SalesforceRollbackSnapshotContextError,
    createSalesforceRollbackSnapshotContext
} = require('./deploymentSnapshot/salesforceRollbackSnapshotContext.service');
const deploymentHistoryService = require('./deploymentHistory.service');
const { orgIdsMatch } = require('./deploymentOrgLock/destinationOrgIdentity.service');
const {
    createRollbackHttpAuthorizationDependencies
} = require('./deploymentSnapshot/rollbackAuthorization.httpProvider');

const INPUT_CODE = Object.freeze({
    HISTORY_ID_REQUIRED: 'ROLLBACK_HISTORY_ID_REQUIRED',
    SNAPSHOT_ID_REQUIRED: 'ROLLBACK_SNAPSHOT_ID_REQUIRED',
    DESTINATION_CREDENTIALS_REQUIRED:
        'ROLLBACK_DESTINATION_CREDENTIALS_REQUIRED',
    HISTORY_SNAPSHOT_MISMATCH: 'ROLLBACK_HISTORY_SNAPSHOT_MISMATCH',
    HISTORY_DESTINATION_MISMATCH: 'ROLLBACK_HISTORY_DESTINATION_MISMATCH',
    SNAPSHOT_EXPORT_MISMATCH: 'ROLLBACK_SNAPSHOT_EXPORT_MISMATCH'
});

function text(value) {
    if (value === undefined || value === null) {
        return '';
    }

    return String(value).trim();
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasSalesforceRollbackContext(request = {}) {
    return (
        isPlainObject(request.snapshotExport) &&
        isPlainObject(request.artifacts)
    );
}

function inputRejected(code, message) {
    return {
        httpStatus: 400,
        body: {
            success: false,
            blocked: true,
            failed: false,
            unknownResult: false,
            code,
            message,
            historyId: null,
            snapshotId: null,
            rollbackOfHistoryId: null,
            operationId: null,
            operationStatus: null,
            checkOnlyDeployment: null,
            deploymentExecution: null,
            deploymentHistory: null
        }
    };
}

function classifyRestoreResult(result) {
    const code = result?.code || null;
    const operationStatus = result?.operationStatus || null;
    const unknown =
        code === ROLLBACK_CODE.RESULT_UNKNOWN ||
        code === ROLLBACK_CODE.RESULT_PERSISTENCE_UNKNOWN ||
        operationStatus === ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT;

    if (unknown) {
        return {
            success: false,
            blocked: false,
            failed: false,
            unknownResult: true
        };
    }

    if (result?.success === true && result?.blocked !== true) {
        return {
            success: true,
            blocked: false,
            failed: false,
            unknownResult: false
        };
    }

    if (result?.blocked === true) {
        return {
            success: false,
            blocked: true,
            failed: false,
            unknownResult: false
        };
    }

    return {
        success: false,
        blocked: false,
        failed: true,
        unknownResult: false
    };
}

function createDeploymentRollbackService(dependencies = {}) {
    const historyService =
        dependencies.historyService || deploymentHistoryService;
    const rollbackHttpAuthorization =
        dependencies.rollbackHttpAuthorization ||
        createRollbackHttpAuthorizationDependencies();
    const createRestoreService =
        dependencies.createRestoreService ||
        ((overrides = {}) =>
            createDestinationSnapshotRestoreService({
                historyService,
                ...rollbackHttpAuthorization,
                ...overrides
            }));
    const restoreService =
        dependencies.restoreService || createRestoreService();

    async function executeRollback(request = {}) {
        const historyId = text(request.historyId);
        const requestedSnapshotId = text(request.snapshotId);
        const refreshToken = text(request.refreshToken);
        const instanceUrl = text(request.instanceUrl);
        const orgId = text(request.orgId);

        if (!historyId) {
            return inputRejected(
                INPUT_CODE.HISTORY_ID_REQUIRED,
                'historyId is required.'
            );
        }

        if (!refreshToken || !instanceUrl || !orgId) {
            return inputRejected(
                INPUT_CODE.DESTINATION_CREDENTIALS_REQUIRED,
                'refreshToken, instanceUrl, and orgId are required.'
            );
        }

        const originalHistory =
            typeof historyService.getHistory === 'function'
                ? historyService.getHistory(historyId)
                : null;

        if (
            originalHistory?.snapshotId &&
            requestedSnapshotId &&
            originalHistory.snapshotId !== requestedSnapshotId
        ) {
            return inputRejected(
                INPUT_CODE.HISTORY_SNAPSHOT_MISMATCH,
                'snapshotId does not match the deployment history record.'
            );
        }

        const snapshotId =
            requestedSnapshotId || originalHistory?.snapshotId || '';

        if (!snapshotId) {
            return inputRejected(
                INPUT_CODE.SNAPSHOT_ID_REQUIRED,
                'snapshotId is required.'
            );
        }

        if (
            originalHistory?.destinationOrgId &&
            !orgIdsMatch(originalHistory.destinationOrgId, orgId)
        ) {
            return inputRejected(
                INPUT_CODE.HISTORY_DESTINATION_MISMATCH,
                'orgId does not match the destination org on the deployment history record.'
            );
        }

        let activeRestoreService = restoreService;

        if (hasSalesforceRollbackContext(request)) {
            const exportSnapshotId = text(request.snapshotExport.snapshotId);

            if (!exportSnapshotId) {
                return inputRejected(
                    INPUT_CODE.SNAPSHOT_ID_REQUIRED,
                    'snapshotExport.snapshotId is required.'
                );
            }

            if (exportSnapshotId !== snapshotId) {
                return inputRejected(
                    INPUT_CODE.SNAPSHOT_EXPORT_MISMATCH,
                    'snapshotId does not match snapshotExport.snapshotId.'
                );
            }

            try {
                const context = await createSalesforceRollbackSnapshotContext(
                    request.snapshotExport,
                    request.artifacts
                );

                activeRestoreService = createRestoreService({
                    captureService: context.captureService,
                    isDurableSnapshotStorageReady: () => true
                });
            } catch (error) {
                if (error instanceof SalesforceRollbackSnapshotContextError) {
                    return inputRejected(error.code, error.message);
                }

                throw error;
            }
        }

        const restoreResult = await activeRestoreService.runRollback({
            snapshotId,
            refreshToken,
            instanceUrl,
            destinationOrgId: orgId,
            historyId,
            rollbackOfHistoryId: historyId
        });

        const classification = classifyRestoreResult(restoreResult);
        const rollbackHistoryId = restoreResult?.historyId || null;
        const deploymentHistory =
            rollbackHistoryId &&
            typeof historyService.getHistory === 'function'
                ? historyService.getHistory(rollbackHistoryId)
                : null;

        return {
            httpStatus: 200,
            body: {
                ...classification,
                code: restoreResult?.code || null,
                message:
                    restoreResult?.message ||
                    (classification.success
                        ? 'Rollback restore completed.'
                        : 'Rollback did not complete.'),
                historyId: rollbackHistoryId,
                snapshotId,
                rollbackOfHistoryId: historyId,
                operationId: restoreResult?.operationId || null,
                operationStatus: restoreResult?.operationStatus || null,
                checkOnlyDeployment:
                    restoreResult?.checkOnlyDeployment || null,
                deploymentExecution:
                    restoreResult?.deploymentExecution || null,
                deploymentHistory
            }
        };
    }

    return {
        executeRollback
    };
}

const defaultService = createDeploymentRollbackService();

module.exports = {
    INPUT_CODE,
    createDeploymentRollbackService,
    executeRollback: defaultService.executeRollback
};
