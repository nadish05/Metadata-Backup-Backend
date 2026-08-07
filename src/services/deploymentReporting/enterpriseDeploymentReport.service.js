/**
 * Enterprise Deployment Report Builder (Phase 17.6).
 *
 * Pure aggregation layer. Combines existing validation outputs into a single
 * frontend-oriented report. Never generates new deployment decisions, never
 * inspects repository/workspace/metadata/package.xml, and never mutates
 * upstream reports.
 */

const REPORT_VERSION = 1;

const NEXT_ACTION_PRIORITY = Object.freeze({
    AUTO_FIX_APPLIED: 1,
    RETRY_VALIDATION: 2,
    MANUAL_METADATA_CHANGE: 3,
    ENABLE_PLATFORM_FEATURE: 4,
    MANUAL_CONFIGURATION: 5,
    INFORMATIONAL: 6
});

function nowIso() {
    return new Date().toISOString();
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function deriveOverallStatus(context) {
    const autoValidationStatus = context.autoValidationReport?.finalStatus;
    if (autoValidationStatus === 'SUCCESS' || autoValidationStatus === 'FAILED') {
        return autoValidationStatus;
    }

    const summaryStatus = String(
        context.deploymentSummary?.deploymentStatus ||
            context.deploymentSummary?.status ||
            ''
    )
        .trim()
        .toUpperCase();

    if (
        summaryStatus === 'SUCCESS' ||
        summaryStatus === 'SUCCEEDED' ||
        context.deploymentSummary?.success === true
    ) {
        return 'SUCCESS';
    }

    if (
        summaryStatus === 'FAILED' ||
        context.deploymentSummary?.success === false
    ) {
        return 'FAILED';
    }

    const failures = asArray(context.failureClassification?.failures);
    if (failures.length > 0) {
        return 'FAILED';
    }

    if (context.autoFixReport?.autoFixApplied === true) {
        return context.autoValidationReport?.finalStatus || 'SUCCESS';
    }

    return 'SUCCESS';
}

function deriveExecutionMode(context) {
    const mode = context.deploymentSummary?.executionMode ||
        context.deploymentSummary?.deploymentMode ||
        context.executionMode ||
        null;

    if (mode === 'DEPLOY' || mode === 'VALIDATE') {
        return mode;
    }

    return mode || 'VALIDATE';
}

function countDiagnostics(deploymentDiagnostics, key) {
    const value = deploymentDiagnostics?.[key];
    if (Array.isArray(value)) {
        return value.length;
    }
    if (typeof value === 'number') {
        return value;
    }
    return null;
}

function buildSummary(context, overallStatus) {
    const diagnostics = context.deploymentDiagnostics || {};
    const deploymentSummary = context.deploymentSummary || {};
    const autoFixReport = context.autoFixReport || {};
    const autoValidationReport = context.autoValidationReport || {};

    const failedFromDiagnostics =
        countDiagnostics(diagnostics, 'componentFailures') ??
        countDiagnostics(diagnostics, 'failures');
    const successFromDiagnostics =
        countDiagnostics(diagnostics, 'componentSuccesses') ??
        countDiagnostics(diagnostics, 'successes');

    const totalFromSummary =
        deploymentSummary.totalComponents ??
        deploymentSummary.componentsValidated ??
        deploymentSummary.componentsDeployed ??
        null;

    const failedMetadata =
        failedFromDiagnostics ??
        deploymentSummary.failedComponents ??
        asArray(context.failureClassification?.failures).length;

    const successfulMetadata =
        successFromDiagnostics ??
        deploymentSummary.successfulComponents ??
        (totalFromSummary != null && failedMetadata != null
            ? Math.max(0, totalFromSummary - failedMetadata)
            : null);

    const totalMetadata =
        totalFromSummary ??
        (successfulMetadata != null && failedMetadata != null
            ? successfulMetadata + failedMetadata
            : null);

    const autoFixesApplied = asArray(autoFixReport.fixes).filter(
        (fix) => fix && fix.successful === true
    ).length;

    return {
        deploymentStatus: overallStatus,
        executionMode: deriveExecutionMode(context),
        duration:
            deploymentSummary.duration ??
            deploymentSummary.durationMs ??
            deploymentSummary.elapsedMs ??
            null,
        totalMetadata,
        successfulMetadata,
        failedMetadata,
        autoFixesApplied,
        validationAttempts:
            autoValidationReport.attempts ??
            (autoValidationReport.revalidated === true ? 2 : 1)
    };
}

function buildFailures(failureClassification) {
    return asArray(failureClassification?.failures).map((failure) => ({
        metadataType: failure.metadataType || null,
        metadataName: failure.metadataName || null,
        category: failure.category || null,
        severity: failure.severity || null,
        reason: failure.reason || null,
        recommendedNextStep: failure.recommendedNextStep || null,
        deterministic: failure.deterministic === true,
        canAutoFix: failure.canAutoFix === true,
        canSafeSkip: failure.canSafeSkip === true,
        evidence: failure.evidence || null
    }));
}

function buildResolutions(resolutionReport) {
    return asArray(resolutionReport?.resolutions).map((resolution) => ({
        metadataType: resolution.metadataType || null,
        metadataName: resolution.metadataName || null,
        resolutionType: resolution.resolutionType || null,
        severity: resolution.severity || null,
        title: resolution.title || null,
        summary: resolution.summary || null,
        recommendation: resolution.recommendation || null,
        autoFixAvailable: resolution.autoFixAvailable === true,
        safeSkipAvailable: resolution.safeSkipAvailable === true,
        retryRecommended: resolution.retryRecommended === true,
        userActionRequired: resolution.userActionRequired === true
    }));
}

function buildAutoFixes(autoFixReport) {
    return asArray(autoFixReport?.fixes).map((fix) => ({
        metadataType: fix.metadataType || null,
        metadataName: fix.metadataName || null,
        fixType: fix.fixType || null,
        action: fix.action || null,
        executed: fix.executed === true,
        successful: fix.successful === true,
        reason: fix.reason || null
    }));
}

function buildAiRecommendations(aiResolutionReport) {
    if (!aiResolutionReport || aiResolutionReport.available === false) {
        return [];
    }

    return asArray(aiResolutionReport.explanations).map((explanation) => ({
        metadataType: explanation.metadataType || null,
        metadataName: explanation.metadataName || null,
        severity: explanation.severity || null,
        title: explanation.title || null,
        why: explanation.why || null,
        impact: explanation.impact || null,
        recommendedAction: explanation.recommendedAction || null,
        bestPractice: explanation.bestPractice || null,
        confidence: explanation.confidence || null
    }));
}

function mapResolutionToNextAction(resolution) {
    const type = String(resolution?.resolutionType || '').toUpperCase();

    if (type === 'RETRY') {
        return {
            priority: NEXT_ACTION_PRIORITY.RETRY_VALIDATION,
            type: 'RETRY_VALIDATION',
            message:
                resolution.recommendation ||
                resolution.summary ||
                'Retry deployment validation.'
        };
    }

    if (type === 'MANUAL_METADATA_CHANGE') {
        return {
            priority: NEXT_ACTION_PRIORITY.MANUAL_METADATA_CHANGE,
            type: 'MANUAL_METADATA_CHANGE',
            message:
                resolution.recommendation ||
                resolution.summary ||
                'Perform a manual metadata change.'
        };
    }

    if (type === 'ENABLE_FEATURE') {
        return {
            priority: NEXT_ACTION_PRIORITY.ENABLE_PLATFORM_FEATURE,
            type: 'ENABLE_PLATFORM_FEATURE',
            message:
                resolution.recommendation ||
                resolution.summary ||
                'Enable the required platform feature.'
        };
    }

    if (type === 'MANUAL_CONFIGURATION' || type === 'DEPENDENCY' || type === 'PACKAGE' || type === 'WORKSPACE') {
        return {
            priority: NEXT_ACTION_PRIORITY.MANUAL_CONFIGURATION,
            type: 'MANUAL_CONFIGURATION',
            message:
                resolution.recommendation ||
                resolution.summary ||
                'Complete the required manual configuration.'
        };
    }

    if (type === 'INFORMATION') {
        return {
            priority: NEXT_ACTION_PRIORITY.INFORMATIONAL,
            type: 'INFORMATIONAL',
            message:
                resolution.recommendation ||
                resolution.summary ||
                'Informational finding only.'
        };
    }

    return {
        priority: NEXT_ACTION_PRIORITY.MANUAL_CONFIGURATION,
        type: 'MANUAL_CONFIGURATION',
        message:
            resolution.recommendation ||
            resolution.summary ||
            'Review the resolution recommendation.'
    };
}

function buildNextActions({ resolutionReport, autoFixReport }) {
    const actions = [];
    const seen = new Set();

    for (const fix of asArray(autoFixReport?.fixes)) {
        if (fix?.successful !== true) {
            continue;
        }

        if (fix.fixType !== 'INCLUDE_DISCOVERED_DEPENDENCY') {
            continue;
        }

        const key = `auto:${fix.metadataType}:${fix.metadataName}:${fix.fixType}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        actions.push({
            priority: NEXT_ACTION_PRIORITY.AUTO_FIX_APPLIED,
            type: 'AUTO_FIX_APPLIED',
            metadataType: fix.metadataType || null,
            metadataName: fix.metadataName || null,
            message:
                fix.action ||
                'Dependency was automatically included during validation.',
            completed: true
        });
    }

    for (const resolution of asArray(resolutionReport?.resolutions)) {
        const mapped = mapResolutionToNextAction(resolution);
        const key = `${mapped.type}:${resolution.metadataType}:${resolution.metadataName}:${mapped.message}`;

        // Skip unresolved dependency/package actions when already auto-fixed.
        if (
            (resolution.resolutionType === 'DEPENDENCY' ||
                resolution.resolutionType === 'PACKAGE') &&
            asArray(autoFixReport?.fixes).some(
                (fix) =>
                    fix.successful === true &&
                    fix.fixType === 'INCLUDE_DISCOVERED_DEPENDENCY' &&
                    String(fix.metadataType || '').toLowerCase() ===
                        String(resolution.metadataType || '').toLowerCase() &&
                    String(fix.metadataName || '').toLowerCase() ===
                        String(resolution.metadataName || '').toLowerCase()
            )
        ) {
            continue;
        }

        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        actions.push({
            priority: mapped.priority,
            type: mapped.type,
            metadataType: resolution.metadataType || null,
            metadataName: resolution.metadataName || null,
            message: mapped.message,
            completed: false
        });
    }

    return actions.sort((a, b) => {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }

        const typeCompare = String(a.type).localeCompare(String(b.type));
        if (typeCompare !== 0) {
            return typeCompare;
        }

        return String(a.metadataName || '').localeCompare(
            String(b.metadataName || '')
        );
    });
}

function buildStatistics(context) {
    const failures = asArray(context.failureClassification?.failures);
    const resolutions = asArray(context.resolutionReport?.resolutions);
    const resolutionSummary = context.resolutionReport?.summary || {};
    const classificationSummary = context.failureClassification?.summary || {};
    const autoFixReport = context.autoFixReport || {};
    const diagnostics = context.deploymentDiagnostics || {};

    const dependencyFailures = resolutions.filter((resolution) =>
        ['DEPENDENCY', 'PACKAGE'].includes(
            String(resolution.resolutionType || '').toUpperCase()
        )
    ).length;

    const compatibilityFailures = failures.filter((failure) => {
        const source = String(failure.evidence?.source || '').toUpperCase();
        const reason = String(failure.reason || '').toLowerCase();
        return (
            source.includes('COMPAT') ||
            reason.includes('compat') ||
            reason.includes('formula') ||
            String(failure.category || '').toUpperCase() === 'SAFE_SKIP'
        );
    }).length;

    const manualActions =
        resolutionSummary.manualActions ??
        classificationSummary.manualAction ??
        resolutions.filter((resolution) =>
            [
                'MANUAL_METADATA_CHANGE',
                'MANUAL_CONFIGURATION',
                'ENABLE_FEATURE'
            ].includes(String(resolution.resolutionType || '').toUpperCase())
        ).length;

    const autoResolved = asArray(autoFixReport.fixes).filter(
        (fix) => fix && fix.successful === true
    ).length;

    const warnings =
        classificationSummary.information ??
        countDiagnostics(diagnostics, 'componentWarnings') ??
        countDiagnostics(diagnostics, 'warnings') ??
        resolutions.filter(
            (resolution) =>
                String(resolution.resolutionType || '').toUpperCase() ===
                'INFORMATION'
        ).length;

    return {
        dependencyFailures,
        compatibilityFailures,
        manualActions,
        autoResolved,
        warnings
    };
}

/**
 * Build the additive enterprise deployment report from existing outputs only.
 *
 * @param {object} context
 * @returns {object}
 */
function buildEnterpriseDeploymentReport(context = {}) {
    const overallStatus = deriveOverallStatus(context);

    return {
        version: REPORT_VERSION,
        generatedAt: context.generatedAt || nowIso(),
        overallStatus,
        summary: buildSummary(context, overallStatus),
        failures: buildFailures(context.failureClassification),
        resolutions: buildResolutions(context.resolutionReport),
        autoFixes: buildAutoFixes(context.autoFixReport),
        aiRecommendations: buildAiRecommendations(context.aiResolutionReport),
        nextActions: buildNextActions({
            resolutionReport: context.resolutionReport,
            autoFixReport: context.autoFixReport
        }),
        statistics: buildStatistics(context)
    };
}

module.exports = {
    buildEnterpriseDeploymentReport,
    NEXT_ACTION_PRIORITY,
    REPORT_VERSION
};
