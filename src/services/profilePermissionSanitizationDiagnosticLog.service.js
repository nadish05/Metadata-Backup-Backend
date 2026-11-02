'use strict';

const LOG_PREFIX = '[PROFILE_PERMISSION_SANITIZATION]';

const SENSITIVE_KEY_PATTERN =
    /token|secret|password|credential|authorization|refresh_token|access_token|client_secret/i;
const PROFILE_XML_SNIPPET_PATTERN = /<Profile[\s\S]*>/i;

let debugEnabledOverride = null;
let logSinkForTests = null;

function isProfilePermissionSanitizationDebugEnabled() {
    if (debugEnabledOverride !== null) {
        return debugEnabledOverride === true;
    }

    return process.env.PROFILE_PERMISSION_SANITIZATION_DEBUG === 'true';
}

function setProfilePermissionSanitizationDebugEnabledForTests(value) {
    debugEnabledOverride = value;
}

function resetProfilePermissionSanitizationDebugForTests() {
    debugEnabledOverride = null;
}

function setProfilePermissionSanitizationLogSinkForTests(sink) {
    logSinkForTests = typeof sink === 'function' ? sink : null;
}

function resetProfilePermissionSanitizationLogSinkForTests() {
    logSinkForTests = null;
}

function sanitizeLogPayload(value, depth = 0) {
    if (depth > 6) {
        return '[truncated]';
    }

    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'string') {
        if (PROFILE_XML_SNIPPET_PATTERN.test(value)) {
            return '[Profile XML omitted]';
        }

        if (value.length > 2000) {
            return `${value.slice(0, 2000)}…[truncated]`;
        }

        return value;
    }

    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeLogPayload(entry, depth + 1));
    }

    if (typeof value === 'object') {
        const sanitized = {};

        for (const [key, nested] of Object.entries(value)) {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
                sanitized[key] = '[redacted]';
                continue;
            }

            sanitized[key] = sanitizeLogPayload(nested, depth + 1);
        }

        return sanitized;
    }

    return value;
}

function emitDiagnostic(event, payload = {}) {
    if (!isProfilePermissionSanitizationDebugEnabled()) {
        return;
    }

    const record = sanitizeLogPayload({
        event,
        timestamp: new Date().toISOString(),
        ...payload
    });
    const line = `${LOG_PREFIX} ${JSON.stringify(record)}`;

    if (logSinkForTests) {
        logSinkForTests(line);
        return;
    }

    console.log(line);
}

function logValidationStarted({
    validationId = null,
    executionPath = null,
    selectedProfileNames = [],
    maxCheckOnlyAttempts = null
} = {}) {
    emitDiagnostic('VALIDATION_STARTED', {
        validationId,
        executionPath,
        selectedProfileNames: [...selectedProfileNames],
        maxCheckOnlyAttempts
    });
}

function logCheckOnlyAttempt({
    validationId = null,
    attempt = null,
    maxAttempts = null,
    success = null,
    componentFailureCount = null,
    deploymentId = null
} = {}) {
    emitDiagnostic('CHECK_ONLY_ATTEMPT', {
        validationId,
        attempt,
        maxAttempts,
        success,
        componentFailureCount,
        deploymentId
    });
}

function logFailureClassification({
    validationId = null,
    attempt = null,
    failures = []
} = {}) {
    emitDiagnostic('FAILURE_CLASSIFICATION', {
        validationId,
        attempt,
        failures
    });
}

function logSanitizationAnalysis({
    validationId = null,
    attempt = null,
    profileName = null,
    permissionName = null,
    matchCount = null,
    enabledTrueCount = null,
    enabledFalseCount = null,
    originalEnabled = null,
    eligible = null,
    blockReason = null
} = {}) {
    emitDiagnostic('SANITIZATION_ANALYSIS', {
        validationId,
        attempt,
        profileName,
        permissionName,
        matchCount,
        enabledTrueCount,
        enabledFalseCount,
        originalEnabled,
        eligibilityDecision: eligible === true ? 'ELIGIBLE' : 'BLOCKED',
        blockReason: blockReason || null
    });
}

function logWorkspaceModification({
    validationId = null,
    attempt = null,
    profileName = null,
    success = null,
    removedPermissionNames = [],
    originalCanonicalSha256 = null,
    finalWorkspaceSha256 = null,
    readBackVerification = null,
    workspaceIntegrityStatus = null,
    blockReason = null
} = {}) {
    emitDiagnostic('WORKSPACE_MODIFICATION', {
        validationId,
        attempt,
        profileName,
        success,
        removedPermissionNames,
        originalCanonicalSha256,
        finalWorkspaceSha256,
        readBackVerification,
        workspaceIntegrityStatus,
        blockReason: blockReason || null
    });
}

function logRetryDecision({
    validationId = null,
    attempt = null,
    sanitizationAttempted = null,
    retryAllowed = null,
    nextAttempt = null,
    stopReason = null,
    continueReason = null
} = {}) {
    emitDiagnostic('RETRY_DECISION', {
        validationId,
        attempt,
        sanitizationAttempted,
        retryAllowed,
        nextAttempt,
        stopReason: stopReason || null,
        continueReason: continueReason || null
    });
}

function logFinalResult({
    validationId = null,
    sanitizationStatus = null,
    sanitizationOverallStatus = null,
    removedCount = null,
    checkOnlyAttempts = null,
    finalCheckOnlySuccess = null,
    canDeploy = null,
    boundArtifactCreated = null,
    blockReason = null
} = {}) {
    emitDiagnostic('FINAL_RESULT', {
        validationId,
        sanitizationStatus,
        sanitizationOverallStatus,
        removedCount,
        checkOnlyAttempts,
        finalCheckOnlySuccess,
        canDeploy,
        boundArtifactCreated,
        blockReason: blockReason || null
    });
}

module.exports = {
    LOG_PREFIX,
    isProfilePermissionSanitizationDebugEnabled,
    setProfilePermissionSanitizationDebugEnabledForTests,
    resetProfilePermissionSanitizationDebugForTests,
    setProfilePermissionSanitizationLogSinkForTests,
    resetProfilePermissionSanitizationLogSinkForTests,
    sanitizeLogPayload,
    emitDiagnostic,
    logValidationStarted,
    logCheckOnlyAttempt,
    logFailureClassification,
    logSanitizationAnalysis,
    logWorkspaceModification,
    logRetryDecision,
    logFinalResult
};
