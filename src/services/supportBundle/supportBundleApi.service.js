/**
 * Support Bundle API orchestration (Phase 17.8)
 *
 * Resolves validation context, validates issue selection, sanitizes,
 * then builds the Support Bundle for DOWNLOAD-only delivery.
 * Does not deploy, validate, auto-fix, call AI, send email, or persist.
 *
 * Architectural limitation:
 * deploymentHistory stores summaries only — not full Phase 17 reports.
 * Therefore validationContext (client-held diagnostic snapshot) is required,
 * allowlisted + sanitized before the builder. historyId/validationId is used
 * for correlation when present in the in-memory history store.
 */

'use strict';

const deploymentHistoryService = require('../deploymentHistory.service');
const {
    sanitizeSupportBundlePayload
} = require('./supportBundleSanitizer');
const {
    buildSupportBundle,
    ISSUE_SCOPE
} = require('./supportBundle.service');

class SupportBundleRequestError extends Error {
    constructor(message, statusCode = 400, code = 'SUPPORT_BUNDLE_BAD_REQUEST') {
        super(message);
        this.name = 'SupportBundleRequestError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

/** Fields permitted from client-supplied validationContext (allowlist). */
const CONTEXT_ALLOWLIST = Object.freeze([
    'historyId',
    'deploymentId',
    'validationCorrelationId',
    'correlationId',
    'requestId',
    'deploymentMode',
    'executionMode',
    'status',
    'overallStatus',
    'success',
    'deploymentReadiness',
    'deploymentReadinessAnalysis',
    'deploymentSummary',
    'packageSummary',
    'selectionSummary',
    'manifestSummary',
    'metadataCount',
    'dependencyCount',
    'membersByType',
    'metadata',
    'dependencies',
    'failureClassification',
    'resolutionReport',
    'autoFixReport',
    'autoValidationReport',
    'enterpriseDeploymentReport',
    'safeSkipReport',
    'deploymentDiagnostics',
    'checkOnlyDeployment',
    'deploymentExecution',
    'salesforceOutcome',
    'aiResolutionReport',
    'aiResolution',
    'dependencyValidation'
]);

/** Keys never taken from client even if somehow listed. */
const CONTEXT_HARD_DENY = Object.freeze(
    new Set(
        [
            'accessToken',
            'refreshToken',
            'authorization',
            'apiKey',
            'clientSecret',
            'password',
            'cookie',
            'privateKey',
            'packageXml',
            'sourceCode',
            'cliStdout',
            'cliStderr',
            'rawFailure',
            'generatedManifest',
            'repoUrl',
            'GITHUB_TOKEN',
            'prompt',
            'systemPrompt'
        ].map((k) => k.toLowerCase())
    )
);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function failureIdentityKey(metadataType, metadataName) {
    return `${String(metadataType || '')
        .trim()
        .toLowerCase()}::${String(metadataName || '')
        .trim()
        .toLowerCase()}`;
}

function allowlistValidationContext(input) {
    if (!isPlainObject(input)) {
        return {};
    }

    const out = {};
    for (const key of CONTEXT_ALLOWLIST) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) {
            continue;
        }
        if (CONTEXT_HARD_DENY.has(String(key).toLowerCase())) {
            continue;
        }
        out[key] = input[key];
    }
    return out;
}

function resolveHistoryRecord(validationId) {
    if (!validationId || typeof validationId !== 'string') {
        return null;
    }
    const trimmed = validationId.trim();
    if (!trimmed) {
        return null;
    }
    return deploymentHistoryService.getHistory(trimmed);
}

function mergeHistoryCorrelation(allowlistedContext, history) {
    if (!history) {
        return allowlistedContext;
    }

    return {
        ...allowlistedContext,
        historyId: history.historyId || allowlistedContext.historyId || null,
        deploymentId:
            history.deploymentId || allowlistedContext.deploymentId || null,
        validationCorrelationId:
            allowlistedContext.validationCorrelationId ||
            history.historyId ||
            null,
        deploymentMode:
            allowlistedContext.deploymentMode ||
            history.deploymentMode ||
            null,
        executionMode:
            allowlistedContext.executionMode ||
            history.executionMode ||
            history.deploymentMode ||
            null
    };
}

function collectFailureKeys(sanitizedPayload) {
    const keys = new Set();
    const add = (entry) => {
        if (!entry) {
            return;
        }
        const type = entry.metadataType || entry.type || entry.componentType;
        const name =
            entry.metadataName ||
            entry.name ||
            entry.componentName ||
            entry.fullName;
        if (!type && !name) {
            return;
        }
        keys.add(failureIdentityKey(type, name));
    };

    asArray(sanitizedPayload?.failureClassification?.failures).forEach(add);
    asArray(sanitizedPayload?.resolutionReport?.resolutions).forEach(add);
    asArray(sanitizedPayload?.deploymentDiagnostics?.componentFailures).forEach(
        add
    );
    asArray(sanitizedPayload?.enterpriseDeploymentReport?.failures).forEach(add);
    asArray(sanitizedPayload?.autoFixReport?.fixes).forEach(add);

    return keys;
}

/**
 * Normalize and validate issueSelection against sanitized payload.
 * @returns {{ scope: string, selectedFailures: Array<{metadataType, metadataName}> }}
 */
function validateIssueSelection(issueSelection, sanitizedPayload) {
    const selection = isPlainObject(issueSelection) ? issueSelection : {};
    const rawScope = String(selection.scope || selection.issueScope || '')
        .trim()
        .toUpperCase();

    let scope = ISSUE_SCOPE.ENTIRE_DEPLOYMENT;
    if (!rawScope || rawScope === ISSUE_SCOPE.ENTIRE_DEPLOYMENT) {
        scope = ISSUE_SCOPE.ENTIRE_DEPLOYMENT;
    } else if (rawScope === ISSUE_SCOPE.SELECTED_FAILURES) {
        scope = ISSUE_SCOPE.SELECTED_FAILURES;
    } else {
        throw new SupportBundleRequestError(
            'Invalid issueSelection.scope. Allowed: ENTIRE_DEPLOYMENT, SELECTED_FAILURES.'
        );
    }

    const rawFailures = selection.failures ?? selection.selectedFailures;

    if (scope === ISSUE_SCOPE.ENTIRE_DEPLOYMENT) {
        return { scope, selectedFailures: [] };
    }

    if (!Array.isArray(rawFailures)) {
        throw new SupportBundleRequestError(
            'issueSelection.failures must be an array when scope is SELECTED_FAILURES.'
        );
    }

    if (rawFailures.length === 0) {
        throw new SupportBundleRequestError(
            'issueSelection.failures must not be empty when scope is SELECTED_FAILURES.'
        );
    }

    const selectedFailures = [];
    for (const item of rawFailures) {
        if (!isPlainObject(item)) {
            throw new SupportBundleRequestError(
                'Each selected failure must be an object with metadataType and metadataName.'
            );
        }
        const metadataType =
            typeof item.metadataType === 'string' ? item.metadataType.trim() : '';
        const metadataName =
            typeof item.metadataName === 'string' ? item.metadataName.trim() : '';

        if (!metadataType) {
            throw new SupportBundleRequestError(
                'Selected failure metadataType is required and must be a non-empty string.'
            );
        }
        if (!metadataName) {
            throw new SupportBundleRequestError(
                'Selected failure metadataName is required and must be a non-empty string.'
            );
        }

        selectedFailures.push({ metadataType, metadataName });
    }

    const available = collectFailureKeys(sanitizedPayload);
    for (const failure of selectedFailures) {
        const key = failureIdentityKey(failure.metadataType, failure.metadataName);
        if (!available.has(key)) {
            throw new SupportBundleRequestError(
                'Selected failure was not found in the validation result.'
            );
        }
    }

    return { scope, selectedFailures };
}

function sanitizeAiReport(aiResolutionReport) {
    if (!isPlainObject(aiResolutionReport)) {
        return null;
    }
    const { payload } = sanitizeSupportBundlePayload(aiResolutionReport);
    if (!isPlainObject(payload) || payload.generated !== true) {
        return null;
    }
    return payload;
}

/**
 * Create a Support Bundle from an API request shape.
 *
 * Order: allowlist → history merge → sanitize → validate selection → build
 * Delivery mode is DOWNLOAD only (no email providers).
 *
 * @param {object} request
 * @param {object} [deps] - injectable for tests
 */
async function createSupportBundleFromRequest(request = {}, deps = {}) {
    const sanitize =
        deps.sanitizeSupportBundlePayload || sanitizeSupportBundlePayload;
    const build = deps.buildSupportBundle || buildSupportBundle;
    const resolveHistory = deps.resolveHistoryRecord || resolveHistoryRecord;

    const callOrder = deps.callOrder || null;

    const body = isPlainObject(request) ? request : {};
    const validationId =
        (typeof body.validationId === 'string' && body.validationId.trim()) ||
        (typeof body.historyId === 'string' && body.historyId.trim()) ||
        '';

    if (!validationId) {
        throw new SupportBundleRequestError(
            'validationId is required.'
        );
    }

    const history = resolveHistory(validationId);
    if (!history) {
        const err = new SupportBundleRequestError(
            'Validation context was not found for the provided validationId.',
            404,
            'SUPPORT_BUNDLE_NOT_FOUND'
        );
        throw err;
    }

    const validationContext = body.validationContext ?? body.context;
    if (!isPlainObject(validationContext)) {
        throw new SupportBundleRequestError(
            'validationContext is required. Full Phase 17 diagnostics are not stored in deployment history; provide the validation response snapshot.'
        );
    }

    // Allowlist first — drop unknown / hard-denied keys before sanitizer.
    let context = allowlistValidationContext(validationContext);
    context = mergeHistoryCorrelation(context, history);

    if (callOrder) {
        callOrder.push('sanitize');
    }
    const sanitizeResult = sanitize(context);
    const sanitizedPayload = sanitizeResult?.payload;
    if (!isPlainObject(sanitizedPayload)) {
        throw new SupportBundleRequestError(
            'Unable to sanitize validation context.',
            500,
            'SUPPORT_BUNDLE_SANITIZE_FAILED'
        );
    }

    // Ensure correlation from history survives sanitization allowlist.
    sanitizedPayload.historyId =
        sanitizedPayload.historyId || history.historyId || null;
    sanitizedPayload.deploymentId =
        sanitizedPayload.deploymentId || history.deploymentId || null;
    sanitizedPayload.validationCorrelationId =
        sanitizedPayload.validationCorrelationId || history.historyId || null;

    const issueSelection = validateIssueSelection(
        body.issueSelection,
        sanitizedPayload
    );

    const aiFromBody = sanitizeAiReport(body.aiResolutionReport);
    const aiFromContext = sanitizeAiReport(
        sanitizedPayload.aiResolutionReport || sanitizedPayload.aiResolution
    );
    const aiResolutionReport = aiFromBody || aiFromContext || null;

    if (callOrder) {
        callOrder.push('build');
    }

    const supportBundle = build({
        sanitizedValidationResult: sanitizedPayload,
        issueSelection: {
            scope: issueSelection.scope,
            selectedFailures: issueSelection.selectedFailures
        },
        aiResolutionReport
    });

    const bundleId = supportBundle?.bundleId || null;

    return {
        success: true,
        supportBundle,
        delivery: {
            mode: 'DOWNLOAD',
            filename: bundleId ? `${bundleId}.json` : null
        },
        architecturalNote:
            'validationContext is client-supplied and allowlisted+sanitized because deployment history does not persist full Phase 17 diagnostic reports.'
    };
}

module.exports = {
    createSupportBundleFromRequest,
    allowlistValidationContext,
    validateIssueSelection,
    collectFailureKeys,
    SupportBundleRequestError,
    CONTEXT_ALLOWLIST,
    ISSUE_SCOPE
};
