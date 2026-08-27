'use strict';

const crypto = require('crypto');

const {
    HistoryCorrelationConflictError,
    HistoryDuplicateError
} = require('./deploymentHistory.errors');
const { sanitizeHistoryRecord } = require('./deploymentHistory.sanitize');
const {
    resolveDefaultHistoryStore,
    resetDefaultHistoryStoreForTests
} = require('./deploymentHistory.persistence');

const STAGES = {
    VALIDATION_STARTED: 'Deployment Validation Started',
    PACKAGE_GENERATED: 'Package Generated',
    MANIFEST_GENERATED: 'Manifest Generated',
    WORKSPACE_BUILT: 'Workspace Built',
    CHECK_ONLY_COMPLETED: 'Check-only Validation Completed',
    DEPLOYMENT_EXECUTED: 'Deployment Executed',
    DEPLOYMENT_COMPLETED: 'Deployment Completed'
};

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function logHistoryEvent(event, details) {
    console.log(event);

    if (details && typeof details === 'object') {
        console.log(JSON.stringify(details));
    }
}

function formatDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}${month}${day}`;
}

function formatDuration(startedAt, completedAt) {
    if (!startedAt || !completedAt) {
        return null;
    }

    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(completedAt).getTime();
    const elapsedMs = Math.max(0, endMs - startMs);

    if (elapsedMs < 1000) {
        return `${elapsedMs}ms`;
    }

    const seconds = Math.round(elapsedMs / 1000);

    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    return remainingSeconds
        ? `${minutes}m ${remainingSeconds}s`
        : `${minutes}m`;
}

function resolveDeploymentMode(deploymentPackage) {
    const mode = deploymentPackage?.deploymentMode;

    if (mode === 'VALIDATE' || mode === 'DEPLOY') {
        return mode;
    }

    if (deploymentPackage?.executeDeployment === true) {
        return 'DEPLOY';
    }

    return 'VALIDATE';
}

function appendTimeline(history, stage) {
    if (!history || !stage) {
        return;
    }

    history.timeline.push({
        stage,
        timestamp: new Date().toISOString()
    });
}

function buildValidationSummary({
    deploymentReadiness,
    metadataValidation,
    dependencyValidation
}) {
    return {
        destinationConnectivity:
            deploymentReadiness?.summary?.destinationConnectivity || null,
        metadataValidation:
            deploymentReadiness?.summary?.metadataValidation || null,
        dependencyValidation:
            deploymentReadiness?.summary?.dependencyValidation || null,
        overallStatus: deploymentReadiness?.overallStatus || null,
        canDeploy: deploymentReadiness?.canDeploy === true
    };
}

function collectErrors({
    deploymentReadiness,
    generatedWorkspace,
    deploymentResult
}) {
    const errors = [];

    if (Array.isArray(deploymentReadiness?.blockingIssues)) {
        errors.push(...deploymentReadiness.blockingIssues);
    }

    if (generatedWorkspace?.status === 'BLOCKED') {
        if (generatedWorkspace.missingFiles?.length) {
            errors.push(
                ...generatedWorkspace.missingFiles.map(
                    (file) => `Missing workspace file: ${file}`
                )
            );
        } else {
            errors.push('Deployment workspace is not ready.');
        }
    }

    if (deploymentResult?.failureDetails?.length) {
        for (const detail of deploymentResult.failureDetails) {
            if (detail?.problem) {
                errors.push(detail.problem);
            }
        }
    }

    if (
        deploymentResult &&
        deploymentResult.success === false &&
        deploymentResult.message
    ) {
        errors.push(deploymentResult.message);
    }

    return [...new Set(errors.filter(Boolean))];
}

function collectWarnings({ deploymentReadiness, deploymentResult }) {
    const warnings = [];

    if (Array.isArray(deploymentReadiness?.warnings)) {
        warnings.push(...deploymentReadiness.warnings);
    }

    if (Array.isArray(deploymentResult?.warnings)) {
        warnings.push(...deploymentResult.warnings);
    }

    return [...new Set(warnings.filter(Boolean))];
}

function resolveHistoryStatus({
    deploymentReadiness,
    generatedWorkspace,
    deploymentResult
}) {
    if (
        deploymentResult?.status === 'UNKNOWN_RESULT' ||
        deploymentResult?.operationStatus === 'UNKNOWN_RESULT'
    ) {
        return 'UNKNOWN_RESULT';
    }

    if (
        deploymentReadiness?.canDeploy === false ||
        generatedWorkspace?.status === 'BLOCKED' ||
        deploymentResult?.status === 'BLOCKED'
    ) {
        return 'BLOCKED';
    }

    if (deploymentResult?.success === true) {
        return 'SUCCESS';
    }

    if (deploymentResult?.success === false) {
        return 'FAILED';
    }

    if (deploymentReadiness?.canDeploy === true) {
        return 'SUCCESS';
    }

    return 'FAILED';
}

function parseDurationToMilliseconds(duration) {
    if (!duration || typeof duration !== 'string') {
        return null;
    }

    const normalized = duration.trim().toLowerCase();
    let totalMs = 0;

    const minuteMatch = normalized.match(/(\d+)\s*m/);

    if (minuteMatch) {
        totalMs += Number.parseInt(minuteMatch[1], 10) * 60 * 1000;
    }

    const secondMatch = normalized.match(/(\d+(?:\.\d+)?)\s*s/);

    if (secondMatch) {
        totalMs += Math.round(Number.parseFloat(secondMatch[1]) * 1000);
    }

    const millisecondMatch = normalized.match(/(\d+)\s*ms/);

    if (millisecondMatch) {
        totalMs += Number.parseInt(millisecondMatch[1], 10);
    }

    if (
        !minuteMatch &&
        !secondMatch &&
        !millisecondMatch &&
        /^\d+$/.test(normalized)
    ) {
        totalMs = Number.parseInt(normalized, 10);
    }

    return totalMs > 0 ? totalMs : null;
}

function resolveDurationMilliseconds(history) {
    if (history?.startedAt && history?.completedAt) {
        const startMs = new Date(history.startedAt).getTime();
        const endMs = new Date(history.completedAt).getTime();

        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
            return endMs - startMs;
        }
    }

    return parseDurationToMilliseconds(history?.duration);
}

function formatAverageDuration(totalMs, count) {
    if (!count || !Number.isFinite(totalMs) || totalMs <= 0) {
        return null;
    }

    const averageMs = totalMs / count;

    if (averageMs < 1000) {
        return `${Math.round(averageMs)}ms`;
    }

    return `${(averageMs / 1000).toFixed(1)}s`;
}

function applySnapshotCorrelation(history, snapshotId) {
    if (snapshotId === undefined) {
        return false;
    }

    const nextId = snapshotId || null;

    if (
        history.snapshotId &&
        nextId &&
        history.snapshotId !== nextId
    ) {
        throw new HistoryCorrelationConflictError(
            `snapshotId conflict for ${history.historyId}: ${history.snapshotId} vs ${nextId}`
        );
    }

    if (!nextId || history.snapshotId === nextId) {
        return false;
    }

    history.snapshotId = nextId;

    return true;
}

function applySalesforceDeploymentCorrelation(history, salesforceDeploymentId) {
    if (salesforceDeploymentId === undefined) {
        return false;
    }

    const nextId = salesforceDeploymentId || null;

    if (!nextId) {
        return false;
    }

    const currentId =
        history.salesforceDeploymentId || history.deploymentId || null;

    if (currentId && currentId !== nextId) {
        throw new HistoryCorrelationConflictError(
            `salesforceDeploymentId conflict for ${history.historyId}: ${currentId} vs ${nextId}`
        );
    }

    if (currentId === nextId) {
        history.deploymentId = nextId;
        history.salesforceDeploymentId = nextId;

        return false;
    }

    history.deploymentId = nextId;
    history.salesforceDeploymentId = nextId;

    return true;
}

function persistRecord(store, history) {
    const sanitized = sanitizeHistoryRecord(history);
    sanitized.updatedAt = new Date().toISOString();

    const saved = store.update(sanitized.historyId, sanitized);

    if (!saved) {
        throw new Error(
            `HISTORY_PERSISTENCE_FAILURE: missing history ${sanitized.historyId}`
        );
    }

    Object.assign(history, saved);

    return saved;
}

function buildApiResponse(history) {
    if (!history) {
        return null;
    }

    const deploymentId =
        history.deploymentId ?? history.salesforceDeploymentId ?? null;

    return {
        historyId: history.historyId ?? null,
        deploymentId,
        salesforceDeploymentId: deploymentId,
        deploymentMode: history.deploymentMode ?? null,
        executionMode: history.executionMode ?? null,
        status: history.status ?? null,
        validationStatus: history.validationStatus ?? null,
        startedAt: history.startedAt ?? null,
        completedAt: history.completedAt ?? null,
        duration: history.duration ?? null,
        durationMilliseconds:
            history.durationMilliseconds ??
            resolveDurationMilliseconds(history),
        cliVersion: history.cliVersion ?? null,
        cliCommand: history.cliCommand ?? null,
        deploymentMessage: history.deploymentMessage ?? null,
        deploymentSummary: history.deploymentSummary ?? null,
        validationSummary: history.validationSummary ?? null,
        timeline: [...(history.timeline || [])],
        warnings: Array.isArray(history.warnings) ? [...history.warnings] : [],
        errors: Array.isArray(history.errors) ? [...history.errors] : [],
        failureDetails: history.failureDetails ?? null,
        testResults: history.testResults ?? null,
        cliCompatibility: history.cliCompatibility ?? null,
        metadataSummary: history.metadataSummary ?? null,
        manifestSummary: history.manifestSummary ?? null,
        workspaceSummary: history.workspaceSummary ?? null,
        deploymentPlanId: history.deploymentPlanId ?? null,
        metadataComparisonId: history.metadataComparisonId ?? null,
        sourceOrgId: history.sourceOrgId ?? null,
        destinationOrgId: history.destinationOrgId ?? null,
        sourceBranch: history.sourceBranch ?? null,
        destinationBranch: history.destinationBranch ?? null,
        snapshotId: history.snapshotId ?? null
    };
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function createDeploymentHistoryService({ store } = {}) {
    let historySequence = 0;
    let lastHistoryDateKey = null;

    function getStore() {
        return store || resolveDefaultHistoryStore();
    }

    function generateHistoryId() {
        const dateKey = formatDateKey();

        if (dateKey !== lastHistoryDateKey) {
            lastHistoryDateKey = dateKey;
            historySequence = 0;
        }

        historySequence += 1;

        const sequentialId = `history_${dateKey}_${String(historySequence).padStart(3, '0')}`;

        if (!getStore().exists(sequentialId)) {
            return sequentialId;
        }

        return `history_${crypto.randomUUID()}`;
    }

    function createHistory({
        deploymentPackage,
        deploymentReadiness,
        metadataValidation,
        dependencyValidation,
        deploymentSelections,
        operationType = null,
        rollbackOfHistoryId = null,
        rollbackOfSnapshotId = null
    } = {}) {
        try {
            logSection('Deployment History Started');

            const startedAt = new Date().toISOString();
            const deploymentMode = resolveDeploymentMode(deploymentPackage);

            const validationSummary = buildValidationSummary({
                deploymentReadiness,
                metadataValidation,
                dependencyValidation
            });

            const history = sanitizeHistoryRecord({
                historyId: generateHistoryId(),
                schemaVersion: 1,
                deploymentMode,
                deploymentId: null,
                salesforceDeploymentId: null,
                executionMode: null,
                status: 'IN_PROGRESS',
                validationStatus: validationSummary?.overallStatus || null,
                startedAt,
                updatedAt: startedAt,
                completedAt: null,
                duration: null,
                durationMilliseconds: null,
                cliVersion: null,
                cliCommand: null,
                deploymentMessage: null,
                sourceBranch:
                    deploymentPackage?.sourceBranch ||
                    deploymentPackage?.branch ||
                    null,
                destinationBranch:
                    deploymentPackage?.destinationBranch ||
                    deploymentPackage?.branch ||
                    null,
                repoUrl: deploymentPackage?.repoUrl || null,
                workspacePath: null,
                metadataSummary: null,
                manifestSummary: null,
                workspaceSummary: null,
                validationSummary,
                deploymentSummary: null,
                failureDetails: null,
                testResults: null,
                cliCompatibility: null,
                errors: [],
                warnings: collectWarnings({ deploymentReadiness }),
                timeline: [],
                deploymentPlanId: deploymentPackage?.deploymentPlanId || null,
                metadataComparisonId:
                    deploymentPackage?.metadataComparisonId || null,
                sourceOrgId: deploymentPackage?.sourceOrgId || null,
                destinationOrgId: deploymentPackage?.destinationOrgId || null,
                snapshotId: null,
                operationType: operationType || null,
                rollbackOfHistoryId: rollbackOfHistoryId || null,
                rollbackOfSnapshotId: rollbackOfSnapshotId || null
            });

            if (
                Array.isArray(deploymentSelections) &&
                deploymentSelections.length > 0
            ) {
                const sanitizedSelections = sanitizeHistoryRecord(
                    deploymentSelections
                );

                console.log('------------------------------------------');
                console.log('DEPLOYMENT SELECTION CREATED');
                console.log('Caller');
                console.log('Deployment History persist');
                console.log('File');
                console.log('deploymentHistory.service.js');
                console.log('Method');
                console.log('createHistory');
                console.log('Current Selection Count');
                console.log(sanitizedSelections.length);
                console.log('Last Added Entry');
                console.log(
                    JSON.stringify(
                        sanitizedSelections[sanitizedSelections.length - 1],
                        null,
                        2
                    )
                );
                console.log('------------------------------------------');

                history.deploymentSelections = sanitizedSelections;
            }

            appendTimeline(history, STAGES.VALIDATION_STARTED);

            const activeStore = getStore();
            let created = null;

            for (let attempt = 0; attempt < 5; attempt += 1) {
                try {
                    created = activeStore.create(history);
                    break;
                } catch (error) {
                    if (
                        error instanceof HistoryDuplicateError &&
                        attempt < 4
                    ) {
                        history.historyId = `history_${crypto.randomUUID()}`;
                        continue;
                    }

                    throw error;
                }
            }

            logHistoryEvent('HISTORY_CREATED', {
                historyId: created.historyId,
                sourceOrgId: created.sourceOrgId,
                destinationOrgId: created.destinationOrgId,
                snapshotId: created.snapshotId,
                salesforceDeploymentId: created.salesforceDeploymentId
            });

            logSection('Deployment History Ready');

            return created.historyId;
        } catch (error) {
            if (error instanceof HistoryCorrelationConflictError) {
                throw error;
            }

            console.error('HISTORY_PERSISTENCE_FAILURE');
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return null;
        }
    }

    function updateHistory(historyId, updates = {}) {
        try {
            if (!historyId) {
                return null;
            }

            const activeStore = getStore();
            const history = activeStore.get(historyId);

            if (!history) {
                return null;
            }

            const {
                stage,
                metadataSummary,
                manifestSummary,
                workspaceSummary,
                deploymentSummary,
                deploymentId,
                workspacePath,
                snapshotId,
                errors,
                warnings
            } = updates;

            if (stage) {
                appendTimeline(history, stage);
            }

            if (metadataSummary !== undefined) {
                history.metadataSummary = metadataSummary;
            }

            if (manifestSummary !== undefined) {
                history.manifestSummary = manifestSummary;
            }

            if (workspaceSummary !== undefined) {
                history.workspaceSummary = workspaceSummary;
                history.workspacePath =
                    workspacePath !== undefined
                        ? workspacePath
                        : workspaceSummary?.workspacePath ||
                          history.workspacePath;
            } else if (workspacePath !== undefined) {
                history.workspacePath = workspacePath;
            }

            if (deploymentSummary !== undefined) {
                history.deploymentSummary = deploymentSummary;
            }

            const snapshotCorrelated = applySnapshotCorrelation(
                history,
                snapshotId
            );
            const deploymentCorrelated = applySalesforceDeploymentCorrelation(
                history,
                deploymentId
            );

            if (Array.isArray(errors) && errors.length) {
                history.errors = [...new Set([...history.errors, ...errors])];
            }

            if (Array.isArray(warnings) && warnings.length) {
                history.warnings = [
                    ...new Set([...history.warnings, ...warnings])
                ];
            }

            const saved = persistRecord(activeStore, history);

            if (snapshotCorrelated) {
                logHistoryEvent('HISTORY_SNAPSHOT_CORRELATED', {
                    historyId: saved.historyId,
                    snapshotId: saved.snapshotId
                });
            }

            if (deploymentCorrelated) {
                logHistoryEvent('HISTORY_DEPLOYMENT_CORRELATED', {
                    historyId: saved.historyId,
                    salesforceDeploymentId: saved.salesforceDeploymentId
                });
            }

            logSection('History Updated');

            return saved;
        } catch (error) {
            if (error instanceof HistoryCorrelationConflictError) {
                throw error;
            }

            console.error('HISTORY_PERSISTENCE_FAILURE');
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return null;
        }
    }

    function completeHistory(historyId, completion = {}) {
        try {
            if (!historyId) {
                return null;
            }

            const activeStore = getStore();
            const history = activeStore.get(historyId);

            if (!history) {
                return null;
            }

            const {
                deploymentReadiness,
                generatedWorkspace,
                deploymentResult,
                deploymentMode,
                destinationOrgId,
                sourceOrgId,
                deploymentPlanId,
                metadataComparisonId,
                snapshotId
            } = completion;

            const sanitizedResult = sanitizeHistoryRecord(deploymentResult);

            if (deploymentMode) {
                history.deploymentMode = deploymentMode;
            }

            const deploymentCorrelated = applySalesforceDeploymentCorrelation(
                history,
                sanitizedResult?.deploymentId
            );

            if (sanitizedResult?.deploymentSummary) {
                history.deploymentSummary = sanitizedResult.deploymentSummary;
            }

            if (sanitizedResult?.executionMode !== undefined) {
                history.executionMode = sanitizedResult.executionMode;
            }

            if (sanitizedResult?.cliVersion !== undefined) {
                history.cliVersion = sanitizedResult.cliVersion;
            }

            if (sanitizedResult?.cliCommand !== undefined) {
                history.cliCommand = sanitizedResult.cliCommand;
            }

            if (sanitizedResult?.message !== undefined) {
                history.deploymentMessage = sanitizedResult.message;
            }

            if (sanitizedResult?.failureDetails !== undefined) {
                history.failureDetails = sanitizedResult.failureDetails;
            }

            if (sanitizedResult?.testResults !== undefined) {
                history.testResults = sanitizedResult.testResults;
            }

            if (sanitizedResult?.cliCompatibility !== undefined) {
                history.cliCompatibility = sanitizedResult.cliCompatibility;
            }

            if (destinationOrgId !== undefined) {
                history.destinationOrgId = destinationOrgId;
            }

            if (sourceOrgId !== undefined) {
                history.sourceOrgId = sourceOrgId;
            }

            if (deploymentPlanId !== undefined) {
                history.deploymentPlanId = deploymentPlanId;
            }

            if (metadataComparisonId !== undefined) {
                history.metadataComparisonId = metadataComparisonId;
            }

            applySnapshotCorrelation(history, snapshotId);

            history.errors = collectErrors({
                deploymentReadiness,
                generatedWorkspace,
                deploymentResult: sanitizedResult
            });
            history.warnings = collectWarnings({
                deploymentReadiness,
                deploymentResult: sanitizedResult
            });
            history.status = resolveHistoryStatus({
                deploymentReadiness,
                generatedWorkspace,
                deploymentResult: sanitizedResult
            });
            history.validationStatus =
                history.validationSummary?.overallStatus || null;
            history.completedAt = new Date().toISOString();
            history.duration = formatDuration(
                history.startedAt,
                history.completedAt
            );
            history.durationMilliseconds =
                history.durationMilliseconds ??
                resolveDurationMilliseconds(history);

            appendTimeline(history, STAGES.DEPLOYMENT_COMPLETED);

            const saved = persistRecord(activeStore, history);

            if (deploymentCorrelated) {
                logHistoryEvent('HISTORY_DEPLOYMENT_CORRELATED', {
                    historyId: saved.historyId,
                    salesforceDeploymentId: saved.salesforceDeploymentId
                });
            }

            logHistoryEvent('HISTORY_COMPLETED', {
                historyId: saved.historyId,
                snapshotId: saved.snapshotId,
                salesforceDeploymentId: saved.salesforceDeploymentId,
                status: saved.status
            });

            logSection('History Completed');

            return buildApiResponse(saved);
        } catch (error) {
            if (error instanceof HistoryCorrelationConflictError) {
                throw error;
            }

            console.error('HISTORY_PERSISTENCE_FAILURE');
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return null;
        }
    }

    function getHistory(historyId) {
        try {
            if (!historyId) {
                return null;
            }

            const history = getStore().get(historyId);

            if (!history) {
                return null;
            }

            return {
                ...history,
                timeline: [...(history.timeline || [])]
            };
        } catch (error) {
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return null;
        }
    }

    function getAllHistory() {
        try {
            return getStore()
                .list()
                .map((history) => ({
                    ...history,
                    timeline: [...(history.timeline || [])]
                }));
        } catch (error) {
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return [];
        }
    }

    function listHistory(options = {}) {
        try {
            const limit = Math.min(
                Math.max(Number(options.limit) || DEFAULT_LIST_LIMIT, 1),
                MAX_LIST_LIMIT
            );
            const sort = options.sort === 'asc' ? 'asc' : 'desc';

            let results = getAllHistory();

            if (options.status) {
                results = results.filter(
                    (history) => history.status === options.status
                );
            }

            if (options.deploymentMode) {
                results = results.filter(
                    (history) =>
                        history.deploymentMode === options.deploymentMode
                );
            }

            results.sort((left, right) => {
                const leftTime = new Date(left.startedAt).getTime() || 0;
                const rightTime = new Date(right.startedAt).getTime() || 0;

                return sort === 'asc'
                    ? leftTime - rightTime
                    : rightTime - leftTime;
            });

            return results.slice(0, limit);
        } catch (error) {
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return [];
        }
    }

    function getLatest() {
        try {
            const [latest] = listHistory({
                limit: 1,
                sort: 'desc'
            });

            return latest || null;
        } catch (error) {
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return null;
        }
    }

    function getStatistics() {
        try {
            const allHistory = getAllHistory();

            let successfulDeployments = 0;
            let failedDeployments = 0;
            let blockedDeployments = 0;
            let validationRuns = 0;
            let deploymentRuns = 0;
            let durationTotalMs = 0;
            let durationCount = 0;
            let lastDeploymentTime = null;

            for (const history of allHistory) {
                if (history.status === 'SUCCESS') {
                    successfulDeployments += 1;
                } else if (history.status === 'FAILED') {
                    failedDeployments += 1;
                } else if (history.status === 'BLOCKED') {
                    blockedDeployments += 1;
                }

                if (history.deploymentMode === 'VALIDATE') {
                    validationRuns += 1;
                } else if (history.deploymentMode === 'DEPLOY') {
                    deploymentRuns += 1;
                }

                const durationMs = resolveDurationMilliseconds(history);

                if (durationMs !== null) {
                    durationTotalMs += durationMs;
                    durationCount += 1;
                }

                const candidateTime = history.completedAt || history.startedAt;

                if (
                    candidateTime &&
                    (!lastDeploymentTime ||
                        new Date(candidateTime).getTime() >
                            new Date(lastDeploymentTime).getTime())
                ) {
                    lastDeploymentTime = candidateTime;
                }
            }

            return {
                totalDeployments: allHistory.length,
                successfulDeployments,
                failedDeployments,
                blockedDeployments,
                validationRuns,
                deploymentRuns,
                averageDuration: formatAverageDuration(
                    durationTotalMs,
                    durationCount
                ),
                lastDeploymentTime
            };
        } catch (error) {
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return {
                totalDeployments: 0,
                successfulDeployments: 0,
                failedDeployments: 0,
                blockedDeployments: 0,
                validationRuns: 0,
                deploymentRuns: 0,
                averageDuration: null,
                lastDeploymentTime: null
            };
        }
    }

    function findBySnapshotId(snapshotId) {
        try {
            if (!snapshotId) {
                return null;
            }

            return getStore().findBySnapshotId(snapshotId);
        } catch (error) {
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return null;
        }
    }

    function findBySalesforceDeploymentId(salesforceDeploymentId) {
        try {
            if (!salesforceDeploymentId) {
                return null;
            }

            return getStore().findBySalesforceDeploymentId(
                salesforceDeploymentId
            );
        } catch (error) {
            console.error('DEPLOYMENT HISTORY ERROR');
            console.error(error);
            return null;
        }
    }

    return {
        STAGES,
        createHistory,
        updateHistory,
        completeHistory,
        getHistory,
        getAllHistory,
        listHistory,
        getLatest,
        getStatistics,
        findBySnapshotId,
        findBySalesforceDeploymentId,
        DEFAULT_LIST_LIMIT,
        MAX_LIST_LIMIT
    };
}

const defaultService = createDeploymentHistoryService();

module.exports = {
    STAGES,
    createHistory: defaultService.createHistory,
    updateHistory: defaultService.updateHistory,
    completeHistory: defaultService.completeHistory,
    getHistory: defaultService.getHistory,
    getAllHistory: defaultService.getAllHistory,
    listHistory: defaultService.listHistory,
    getLatest: defaultService.getLatest,
    getStatistics: defaultService.getStatistics,
    findBySnapshotId: defaultService.findBySnapshotId,
    findBySalesforceDeploymentId: defaultService.findBySalesforceDeploymentId,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
    createDeploymentHistoryService,
    resetDefaultHistoryStoreForTests
};
