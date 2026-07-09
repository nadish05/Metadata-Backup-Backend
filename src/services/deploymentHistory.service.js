const crypto = require('crypto');

const historyStore = new Map();
let historySequence = 0;
let lastHistoryDateKey = null;

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

function formatDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}${month}${day}`;
}

function generateHistoryId() {
    const dateKey = formatDateKey();

    if (dateKey !== lastHistoryDateKey) {
        lastHistoryDateKey = dateKey;
        historySequence = 0;
    }

    historySequence += 1;

    const sequentialId = `history_${dateKey}_${String(historySequence).padStart(3, '0')}`;

    if (!historyStore.has(sequentialId)) {
        return sequentialId;
    }

    return `history_${crypto.randomUUID()}`;
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

function buildResponseSummary(history) {
    return {
        metadataCount: history.metadataSummary?.metadataCount ?? 0,
        dependencyCount: history.metadataSummary?.dependencyCount ?? 0,
        componentsValidated:
            history.deploymentSummary?.componentsValidated ??
            history.deploymentSummary?.componentsDeployed ??
            0,
        workspaceCreated: history.workspaceSummary?.workspaceCreated === true,
        deploymentMode: history.deploymentMode || 'VALIDATE',
        deploymentStatus:
            history.deploymentSummary?.deploymentStatus ||
            history.status ||
            null
    };
}

function buildApiResponse(history) {
    if (!history) {
        return null;
    }

    return {
        historyId: history.historyId,
        status: history.status,
        startedAt: history.startedAt,
        completedAt: history.completedAt,
        duration: history.duration,
        timeline: [...(history.timeline || [])],
        summary: buildResponseSummary(history)
    };
}

function createHistory({
    deploymentPackage,
    deploymentReadiness,
    metadataValidation,
    dependencyValidation
} = {}) {
    try {
        logSection('Deployment History Started');

        const historyId = generateHistoryId();
        const startedAt = new Date().toISOString();
        const deploymentMode = resolveDeploymentMode(deploymentPackage);

        const history = {
            historyId,
            deploymentMode,
            deploymentId: null,
            status: 'IN_PROGRESS',
            startedAt,
            completedAt: null,
            duration: null,
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
            validationSummary: buildValidationSummary({
                deploymentReadiness,
                metadataValidation,
                dependencyValidation
            }),
            deploymentSummary: null,
            errors: [],
            warnings: collectWarnings({ deploymentReadiness }),
            timeline: []
        };

        appendTimeline(history, STAGES.VALIDATION_STARTED);
        historyStore.set(historyId, history);

        logSection('Deployment History Ready');

        return historyId;
    } catch (error) {
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

        const history = historyStore.get(historyId);

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
                    : workspaceSummary?.workspacePath || history.workspacePath;
        } else if (workspacePath !== undefined) {
            history.workspacePath = workspacePath;
        }

        if (deploymentSummary !== undefined) {
            history.deploymentSummary = deploymentSummary;
        }

        if (deploymentId !== undefined) {
            history.deploymentId = deploymentId;
        }

        if (Array.isArray(errors) && errors.length) {
            history.errors = [...new Set([...history.errors, ...errors])];
        }

        if (Array.isArray(warnings) && warnings.length) {
            history.warnings = [...new Set([...history.warnings, ...warnings])];
        }

        logSection('History Updated');

        return history;
    } catch (error) {
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

        const history = historyStore.get(historyId);

        if (!history) {
            return null;
        }

        const {
            deploymentReadiness,
            generatedWorkspace,
            deploymentResult,
            deploymentMode
        } = completion;

        if (deploymentMode) {
            history.deploymentMode = deploymentMode;
        }

        if (deploymentResult?.deploymentId) {
            history.deploymentId = deploymentResult.deploymentId;
        }

        if (deploymentResult?.deploymentSummary) {
            history.deploymentSummary = deploymentResult.deploymentSummary;
        }

        history.errors = collectErrors({
            deploymentReadiness,
            generatedWorkspace,
            deploymentResult
        });
        history.warnings = collectWarnings({
            deploymentReadiness,
            deploymentResult
        });
        history.status = resolveHistoryStatus({
            deploymentReadiness,
            generatedWorkspace,
            deploymentResult
        });
        history.completedAt = new Date().toISOString();
        history.duration = formatDuration(
            history.startedAt,
            history.completedAt
        );

        appendTimeline(history, STAGES.DEPLOYMENT_COMPLETED);

        logSection('History Completed');

        return buildApiResponse(history);
    } catch (error) {
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

        const history = historyStore.get(historyId);

        if (!history) {
            return null;
        }

        return {
            ...history,
            timeline: [...history.timeline]
        };
    } catch (error) {
        console.error('DEPLOYMENT HISTORY ERROR');
        console.error(error);
        return null;
    }
}

function getAllHistory() {
    try {
        return [...historyStore.values()].map((history) => ({
            ...history,
            timeline: [...history.timeline]
        }));
    } catch (error) {
        console.error('DEPLOYMENT HISTORY ERROR');
        console.error(error);
        return [];
    }
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

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
                (history) => history.deploymentMode === options.deploymentMode
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

module.exports = {
    STAGES,
    createHistory,
    updateHistory,
    completeHistory,
    getHistory,
    getAllHistory,
    listHistory,
    getLatest,
    getStatistics,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT
};
