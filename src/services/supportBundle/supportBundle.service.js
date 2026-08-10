/**
 * Enterprise Support Bundle Builder (Phase 17.8.2)
 *
 * Pure aggregation layer. Transforms an already-sanitized validation result
 * into a structured Support Bundle snapshot.
 *
 * Does NOT:
 * - call the sanitizer (input is assumed sanitized)
 * - invoke AI
 * - execute deploy / auto-fix / auto-validation
 * - mutate inputs
 * - invent diagnostic data
 */

'use strict';

const crypto = require('crypto');

const packageJson = require('../../../package.json');

const BUNDLE_VERSION = 1;
const PRODUCT_NAME = 'Metadata Backup Backend';
const DISCLAIMER =
    'Support Bundle is diagnostic only. It does not change deployment decisions.';

const ISSUE_SCOPE = Object.freeze({
    ENTIRE_DEPLOYMENT: 'ENTIRE_DEPLOYMENT',
    SELECTED_FAILURES: 'SELECTED_FAILURES'
});

function nowIso() {
    return new Date().toISOString();
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function shallowClone(value) {
    if (Array.isArray(value)) {
        return value.map((item) =>
            isPlainObject(item) ? { ...item } : item
        );
    }
    if (isPlainObject(value)) {
        return { ...value };
    }
    return value;
}

function deepCloneJsonSafe(value) {
    if (value === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_err) {
        return shallowClone(value);
    }
}

/**
 * Generate SUP-YYYYMMDD-XXXXXX (UTC date + 6 hex chars).
 */
function generateBundleId(now = new Date()) {
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `SUP-${yyyy}${mm}${dd}-${suffix}`;
}

function failureIdentityKey(metadataType, metadataName) {
    return `${String(metadataType || '')
        .trim()
        .toLowerCase()}::${String(metadataName || '')
        .trim()
        .toLowerCase()}`;
}

function matchesSelectedFailure(entry, selectedKeys) {
    if (!entry || selectedKeys.size === 0) {
        return false;
    }
    const type = entry.metadataType || entry.type || entry.componentType || null;
    const name =
        entry.metadataName || entry.name || entry.componentName || entry.fullName || null;
    if (!type && !name) {
        return false;
    }
    return selectedKeys.has(failureIdentityKey(type, name));
}

function normalizeIssueSelection(issueSelection, sanitized) {
    const selectedFailures = asArray(issueSelection?.selectedFailures)
        .filter((item) => item && (item.metadataType || item.metadataName))
        .map((item) => ({
            metadataType: item.metadataType || null,
            metadataName: item.metadataName || null
        }));

    const explicitScope = String(issueSelection?.scope || issueSelection?.issueScope || '')
        .trim()
        .toUpperCase();

    let issueScope = ISSUE_SCOPE.ENTIRE_DEPLOYMENT;
    if (
        explicitScope === ISSUE_SCOPE.SELECTED_FAILURES ||
        selectedFailures.length > 0
    ) {
        issueScope = ISSUE_SCOPE.SELECTED_FAILURES;
    }

    const availableKeys = collectAvailableFailureKeys(sanitized);
    const matchedSelected = [];
    const selectedKeys = new Set();

    for (const failure of selectedFailures) {
        const key = failureIdentityKey(failure.metadataType, failure.metadataName);
        if (!availableKeys.has(key)) {
            // Builder ignores unknown selections; API will 400 later.
            continue;
        }
        if (!selectedKeys.has(key)) {
            selectedKeys.add(key);
            matchedSelected.push({
                metadataType: failure.metadataType || null,
                metadataName: failure.metadataName || null
            });
        }
    }

    if (issueScope === ISSUE_SCOPE.SELECTED_FAILURES && matchedSelected.length === 0) {
        // No valid matches → fall back to entire deployment snapshot
        return {
            issueScope: ISSUE_SCOPE.ENTIRE_DEPLOYMENT,
            selectedFailures: [],
            selectedKeys: new Set()
        };
    }

    return {
        issueScope,
        selectedFailures: matchedSelected,
        selectedKeys
    };
}

function collectAvailableFailureKeys(sanitized) {
    const keys = new Set();
    const add = (entry) => {
        if (!entry) {
            return;
        }
        const type = entry.metadataType || entry.type || entry.componentType || null;
        const name =
            entry.metadataName ||
            entry.name ||
            entry.componentName ||
            entry.fullName ||
            null;
        if (!type && !name) {
            return;
        }
        keys.add(failureIdentityKey(type, name));
    };

    asArray(sanitized?.failureClassification?.failures).forEach(add);
    asArray(sanitized?.resolutionReport?.resolutions).forEach(add);
    asArray(sanitized?.deploymentDiagnostics?.componentFailures).forEach(add);
    asArray(sanitized?.enterpriseDeploymentReport?.failures).forEach(add);
    asArray(sanitized?.autoFixReport?.fixes).forEach(add);

    return keys;
}

function filterBySelection(items, selectedKeys, issueScope) {
    const list = asArray(items);
    if (issueScope !== ISSUE_SCOPE.SELECTED_FAILURES || selectedKeys.size === 0) {
        return list.map((item) => deepCloneJsonSafe(item));
    }
    return list
        .filter((item) => matchesSelectedFailure(item, selectedKeys))
        .map((item) => deepCloneJsonSafe(item));
}

function snapshotReport(report, mapper) {
    if (report == null) {
        return {};
    }
    if (!isPlainObject(report) && !Array.isArray(report)) {
        return {};
    }
    return mapper(deepCloneJsonSafe(report));
}

function buildFailureClassification(sanitized, selectedKeys, issueScope) {
    return snapshotReport(sanitized.failureClassification, (report) => {
        if (!isPlainObject(report)) {
            return {};
        }
        return {
            ...report,
            failures: filterBySelection(report.failures, selectedKeys, issueScope)
        };
    });
}

function buildResolutionReport(sanitized, selectedKeys, issueScope) {
    return snapshotReport(sanitized.resolutionReport, (report) => {
        if (!isPlainObject(report)) {
            return {};
        }
        return {
            ...report,
            resolutions: filterBySelection(report.resolutions, selectedKeys, issueScope)
        };
    });
}

function buildAutoFixReport(sanitized, selectedKeys, issueScope) {
    return snapshotReport(sanitized.autoFixReport, (report) => {
        if (!isPlainObject(report)) {
            return {};
        }
        return {
            ...report,
            fixes: filterBySelection(report.fixes, selectedKeys, issueScope)
        };
    });
}

function buildAutoValidationReport(sanitized) {
    return snapshotReport(sanitized.autoValidationReport, (report) => {
        if (!isPlainObject(report)) {
            return {};
        }
        return { ...report };
    });
}

function buildEnterpriseDeploymentReportSnapshot(sanitized, selectedKeys, issueScope) {
    return snapshotReport(sanitized.enterpriseDeploymentReport, (report) => {
        if (!isPlainObject(report)) {
            return {};
        }
        if (issueScope !== ISSUE_SCOPE.SELECTED_FAILURES || selectedKeys.size === 0) {
            return { ...report };
        }
        return {
            ...report,
            failures: filterBySelection(report.failures, selectedKeys, issueScope),
            resolutions: filterBySelection(report.resolutions, selectedKeys, issueScope),
            autoFixes: filterBySelection(report.autoFixes, selectedKeys, issueScope)
        };
    });
}

function buildDeploymentDiagnostics(sanitized, selectedKeys, issueScope) {
    return snapshotReport(sanitized.deploymentDiagnostics, (report) => {
        if (!isPlainObject(report)) {
            return {};
        }
        const out = {
            deploymentId: report.deploymentId ?? null,
            overallStatus: report.overallStatus ?? report.status ?? null,
            summary: report.summary != null ? deepCloneJsonSafe(report.summary) : {},
            componentFailures: filterBySelection(
                report.componentFailures,
                selectedKeys,
                issueScope
            )
        };
        // Never reintroduce raw CLI / raw failure fields even if present
        return out;
    });
}

function buildSalesforceOutcome(sanitized) {
    const diagnostics = sanitized.deploymentDiagnostics || {};
    const summary = sanitized.deploymentSummary || {};
    const checkOnly = sanitized.checkOnlyDeployment || {};
    const execution = sanitized.deploymentExecution || {};
    const salesforceOutcome = sanitized.salesforceOutcome || {};

    const status =
        salesforceOutcome.status ??
        diagnostics.overallStatus ??
        summary.deploymentStatus ??
        summary.status ??
        checkOnly.status ??
        execution.status ??
        null;

    const message =
        salesforceOutcome.message ??
        summary.message ??
        checkOnly.message ??
        execution.message ??
        null;

    const duration =
        salesforceOutcome.duration ??
        summary.duration ??
        summary.durationMs ??
        checkOnly.duration ??
        execution.duration ??
        null;

    const deploymentId =
        salesforceOutcome.deploymentId ??
        diagnostics.deploymentId ??
        summary.deploymentId ??
        checkOnly.deploymentId ??
        execution.deploymentId ??
        null;

    const cliVersion =
        salesforceOutcome.cliVersion ??
        summary.cliVersion ??
        checkOnly.cliVersion ??
        execution.cliVersion ??
        null;

    const cliCommandRedacted =
        salesforceOutcome.cliCommandRedacted ??
        summary.cliCommandRedacted ??
        null;

    return {
        status: status ?? null,
        message: message ?? null,
        duration: duration ?? null,
        deploymentId: deploymentId ?? null,
        cliVersion: cliVersion ?? null,
        cliCommandRedacted: cliCommandRedacted ?? null
    };
}

function buildAiResolution(aiResolutionReport, sanitized) {
    const report =
        aiResolutionReport && isPlainObject(aiResolutionReport)
            ? aiResolutionReport
            : sanitized?.aiResolutionReport || sanitized?.aiResolution || null;

    if (!report || !isPlainObject(report) || report.generated !== true) {
        return { present: false };
    }

    return {
        present: true,
        advisoryOnly: true,
        aiGenerated: true,
        provider: report.provider ?? null,
        generated: true,
        fallbackUsed: report.fallbackUsed === true,
        summary: report.summary ?? null,
        explanations: deepCloneJsonSafe(asArray(report.explanations)),
        disclaimer: report.disclaimer ?? null,
        resolutionCategory: report.resolutionCategory ?? null,
        backendCanAutoFix: report.backendCanAutoFix ?? null,
        userActionRequired: report.userActionRequired ?? null,
        safeToSkip:
            report.safeToSkip === true
                ? true
                : report.safeToSkip === false
                  ? false
                  : report.safeToSkip === null
                    ? null
                    : null
    };
}

function buildEnvironment() {
    return {
        nodeEnv: process.env.NODE_ENV || null,
        deploymentDebugEnabled: process.env.DEPLOYMENT_DEBUG === 'true',
        aiEnabled: process.env.AI_ENABLED === 'true'
    };
}

function buildProduct() {
    const version =
        typeof packageJson.version === 'string' && packageJson.version.trim()
            ? packageJson.version.trim()
            : null;

    return {
        name: PRODUCT_NAME,
        version
    };
}

function extractCorrelation(sanitized) {
    return {
        historyId: sanitized.historyId ?? sanitized.correlation?.historyId ?? null,
        deploymentId:
            sanitized.deploymentId ??
            sanitized.deploymentDiagnostics?.deploymentId ??
            sanitized.deploymentSummary?.deploymentId ??
            sanitized.correlation?.deploymentId ??
            null,
        validationCorrelationId:
            sanitized.validationCorrelationId ??
            sanitized.correlationId ??
            sanitized.requestId ??
            sanitized.correlation?.validationCorrelationId ??
            sanitized.historyId ??
            null
    };
}

function extractRequestModes(sanitized) {
    const deploymentMode =
        sanitized.deploymentMode ??
        sanitized.deploymentSummary?.deploymentMode ??
        sanitized.enterpriseDeploymentReport?.summary?.executionMode ??
        null;

    const executionMode =
        sanitized.executionMode ??
        sanitized.deploymentSummary?.executionMode ??
        sanitized.enterpriseDeploymentReport?.summary?.executionMode ??
        deploymentMode ??
        null;

    return {
        deploymentMode: deploymentMode ?? null,
        executionMode: executionMode ?? null
    };
}

function buildStatus(sanitized) {
    const enterpriseOverallStatus =
        sanitized.enterpriseDeploymentReport?.overallStatus ?? null;

    const deploymentReadiness =
        sanitized.deploymentReadiness?.overallStatus ??
        sanitized.deploymentReadiness?.status ??
        sanitized.deploymentReadinessAnalysis?.overallStatus ??
        sanitized.deploymentReadinessAnalysis?.status ??
        (typeof sanitized.deploymentReadiness === 'string'
            ? sanitized.deploymentReadiness
            : null);

    const overallStatus =
        enterpriseOverallStatus ??
        deploymentReadiness ??
        sanitized.deploymentSummary?.deploymentStatus ??
        sanitized.deploymentSummary?.status ??
        sanitized.autoValidationReport?.finalStatus ??
        sanitized.status ??
        sanitized.overallStatus ??
        null;

    return {
        overallStatus: overallStatus ?? null,
        deploymentReadiness: deploymentReadiness ?? null,
        enterpriseOverallStatus: enterpriseOverallStatus ?? null
    };
}

function buildSelectionSummary(sanitized) {
    const packageSummary =
        sanitized.packageSummary ||
        sanitized.selectionSummary ||
        sanitized.generatedManifest?.summary ||
        sanitized.manifestSummary ||
        {};

    const membersByType =
        packageSummary.membersByType ||
        sanitized.membersByType ||
        sanitized.selectionSummary?.membersByType ||
        null;

    let metadataCount =
        packageSummary.metadataCount ??
        sanitized.selectionSummary?.metadataCount ??
        sanitized.metadataCount ??
        null;

    let dependencyCount =
        packageSummary.dependencyCount ??
        sanitized.selectionSummary?.dependencyCount ??
        sanitized.dependencyCount ??
        null;

    if (metadataCount == null && Array.isArray(sanitized.metadata)) {
        metadataCount = sanitized.metadata.length;
    }
    if (dependencyCount == null && Array.isArray(sanitized.dependencies)) {
        dependencyCount = sanitized.dependencies.length;
    }

    // Prefer null over guessing when nothing reliable exists
    const hasMembers =
        membersByType &&
        isPlainObject(membersByType) &&
        Object.keys(membersByType).length > 0;

    return {
        metadataCount: metadataCount == null ? null : metadataCount,
        dependencyCount: dependencyCount == null ? null : dependencyCount,
        membersByType: hasMembers ? deepCloneJsonSafe(membersByType) : {}
    };
}

function stageFromEntry(entry) {
    const raw = String(
        entry?.stage || entry?.phase || entry?.source || entry?.origin || ''
    )
        .trim()
        .toUpperCase();

    const known = new Set([
        'DISCOVERY',
        'DEPENDENCY',
        'DESTINATION_VALIDATION',
        'PACKAGE',
        'WORKSPACE',
        'COMPATIBILITY',
        'CHECK_ONLY',
        'DEPLOYMENT',
        'DEPLOY',
        'VALIDATE'
    ]);

    if (!raw) {
        return null;
    }
    if (raw === 'DEPLOY') {
        return 'DEPLOYMENT';
    }
    if (raw === 'VALIDATE' || raw === 'CHECKONLY' || raw === 'CHECK-ONLY') {
        return raw.includes('CHECK') ? 'CHECK_ONLY' : null;
    }
    if (known.has(raw)) {
        return raw === 'DEPLOY' ? 'DEPLOYMENT' : raw;
    }
    return null;
}

function buildReproHints(sanitized, selectedKeys, issueScope) {
    const stages = new Set();
    const blockingComponents = [];
    const errorCodes = new Set();
    const seenComponents = new Set();

    const consider = (entry) => {
        if (!entry) {
            return;
        }
        if (
            issueScope === ISSUE_SCOPE.SELECTED_FAILURES &&
            selectedKeys.size > 0 &&
            !matchesSelectedFailure(entry, selectedKeys)
        ) {
            return;
        }

        const stage = stageFromEntry(entry);
        if (stage) {
            stages.add(stage);
        }

        const code = entry.errorCode || entry.problemType || entry.code || null;
        if (code) {
            errorCodes.add(String(code));
        }

        const type = entry.metadataType || entry.type || entry.componentType || null;
        const name =
            entry.metadataName ||
            entry.name ||
            entry.componentName ||
            entry.fullName ||
            null;
        if (type || name) {
            const key = failureIdentityKey(type, name);
            if (!seenComponents.has(key)) {
                seenComponents.add(key);
                blockingComponents.push({
                    metadataType: type,
                    metadataName: name
                });
            }
        }
    };

    asArray(sanitized.failureClassification?.failures).forEach(consider);
    asArray(sanitized.deploymentDiagnostics?.componentFailures).forEach(consider);
    asArray(sanitized.resolutionReport?.resolutions).forEach(consider);

    // Infer stages only from present report sections (not invented empty ones)
    if (sanitized.dependencyValidation || sanitized.dependencyExplorer) {
        if (asArray(sanitized.failureClassification?.failures).some((f) =>
            String(f.category || '').toUpperCase().includes('DEPEND')
        )) {
            stages.add('DEPENDENCY');
        }
    }
    if (sanitized.deploymentDiagnostics && asArray(sanitized.deploymentDiagnostics.componentFailures).length) {
        const mode = String(
            sanitized.deploymentMode || sanitized.executionMode || ''
        ).toUpperCase();
        if (mode === 'DEPLOY') {
            stages.add('DEPLOYMENT');
        } else if (mode === 'VALIDATE' || mode === 'CHECK_ONLY') {
            stages.add('CHECK_ONLY');
        }
    }

    return {
        stages: [...stages],
        blockingComponents,
        errorCodes: [...errorCodes]
    };
}

function buildSafeToSkipHints(sanitized, selectedKeys, issueScope) {
    const items = [];
    const seen = new Set();

    const consider = (entry) => {
        if (!entry) {
            return;
        }
        if (
            issueScope === ISSUE_SCOPE.SELECTED_FAILURES &&
            selectedKeys.size > 0 &&
            !matchesSelectedFailure(entry, selectedKeys)
        ) {
            return;
        }

        const hasExplicit =
            Object.prototype.hasOwnProperty.call(entry, 'safeToSkip') ||
            Object.prototype.hasOwnProperty.call(entry, 'canSafeSkip') ||
            Object.prototype.hasOwnProperty.call(entry, 'safeSkipAvailable');

        if (!hasExplicit) {
            return;
        }

        const type = entry.metadataType || entry.type || null;
        const name = entry.metadataName || entry.name || null;
        const key = failureIdentityKey(type, name);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);

        let safeToSkip = null;
        if (entry.safeToSkip === true || entry.canSafeSkip === true) {
            safeToSkip = true;
        } else if (entry.safeToSkip === false || entry.canSafeSkip === false) {
            safeToSkip = false;
        } else if (entry.safeToSkip === null || entry.canSafeSkip === null) {
            safeToSkip = null;
        } else if (entry.safeSkipAvailable === true) {
            // Availability flag is not a decision — leave null
            safeToSkip = null;
        } else if (entry.safeSkipAvailable === false) {
            safeToSkip = false;
        }

        items.push({
            metadataType: type,
            metadataName: name,
            safeToSkip
        });
    };

    asArray(sanitized.failureClassification?.failures).forEach(consider);
    asArray(sanitized.resolutionReport?.resolutions).forEach(consider);

    return { items };
}

/**
 * Build an Enterprise Support Bundle from an already-sanitized validation result.
 *
 * @param {object} options
 * @param {object} options.sanitizedValidationResult - Output of sanitizer payload
 * @param {object} [options.issueSelection]
 * @param {object|null} [options.aiResolutionReport]
 * @param {string} [options.generatedAt] - Optional ISO timestamp (tests)
 * @param {string} [options.bundleId] - Optional override (tests)
 * @returns {object}
 */
function buildSupportBundle({
    sanitizedValidationResult,
    issueSelection = null,
    aiResolutionReport = null,
    generatedAt = null,
    bundleId = null
} = {}) {
    const sanitized = isPlainObject(sanitizedValidationResult)
        ? sanitizedValidationResult
        : {};

    const selection = normalizeIssueSelection(issueSelection, sanitized);
    const modes = extractRequestModes(sanitized);
    const generated = generatedAt || nowIso();
    const id = bundleId || generateBundleId(new Date(generated));

    return {
        bundleVersion: BUNDLE_VERSION,
        bundleId: id,
        generatedAt: generated,

        product: buildProduct(),

        correlation: extractCorrelation(sanitized),

        request: {
            deploymentMode: modes.deploymentMode,
            executionMode: modes.executionMode,
            issueScope: selection.issueScope,
            selectedFailures: selection.selectedFailures.map((f) => ({ ...f }))
        },

        status: buildStatus(sanitized),

        selectionSummary: buildSelectionSummary(sanitized),

        failureClassification: buildFailureClassification(
            sanitized,
            selection.selectedKeys,
            selection.issueScope
        ),
        resolutionReport: buildResolutionReport(
            sanitized,
            selection.selectedKeys,
            selection.issueScope
        ),
        autoFixReport: buildAutoFixReport(
            sanitized,
            selection.selectedKeys,
            selection.issueScope
        ),
        autoValidationReport: buildAutoValidationReport(sanitized),
        enterpriseDeploymentReport: buildEnterpriseDeploymentReportSnapshot(
            sanitized,
            selection.selectedKeys,
            selection.issueScope
        ),

        deploymentDiagnostics: buildDeploymentDiagnostics(
            sanitized,
            selection.selectedKeys,
            selection.issueScope
        ),
        salesforceOutcome: buildSalesforceOutcome(sanitized),

        aiResolution: buildAiResolution(aiResolutionReport, sanitized),

        environment: buildEnvironment(),

        reproHints: buildReproHints(
            sanitized,
            selection.selectedKeys,
            selection.issueScope
        ),

        safeToSkipHints: buildSafeToSkipHints(
            sanitized,
            selection.selectedKeys,
            selection.issueScope
        ),

        sanitization: {
            applied: true,
            version: 1
        },

        disclaimer: DISCLAIMER
    };
}

module.exports = {
    buildSupportBundle,
    generateBundleId,
    BUNDLE_VERSION,
    PRODUCT_NAME,
    DISCLAIMER,
    ISSUE_SCOPE
};
