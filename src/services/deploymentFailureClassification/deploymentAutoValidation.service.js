/**
 * Deployment Auto Validation Loop (Phase 17.4).
 *
 * After successful deterministic Auto Fixes, orchestrates ONE additional
 * validation pass by reusing validateDeployment. Never retries DEPLOY
 * execution, never recurses, never mutates source metadata.
 */

const MAX_VALIDATION_ATTEMPTS = 2;

function isAutoValidationReentry(autoValidationContext) {
    if (!autoValidationContext || typeof autoValidationContext !== 'object') {
        return false;
    }

    if (autoValidationContext.isRevalidation === true) {
        return true;
    }

    const attempt = Number(autoValidationContext.attempt) || 1;
    return attempt >= MAX_VALIDATION_ATTEMPTS;
}

function shouldRunAutoValidation({ autoFixReport, autoValidationContext }) {
    if (isAutoValidationReentry(autoValidationContext)) {
        return false;
    }

    return autoFixReport?.autoFixApplied === true;
}

function countAutoFixesApplied(autoFixReport) {
    if (!Array.isArray(autoFixReport?.fixes)) {
        return 0;
    }

    return autoFixReport.fixes.filter(
        (fix) => fix && fix.successful === true
    ).length;
}

function deriveValidationStatus(response) {
    if (!response || typeof response !== 'object') {
        return 'FAILED';
    }

    if (response.deploymentSkipped === true) {
        return 'FAILED';
    }

    const outcome =
        response.deploymentExecution || response.checkOnlyDeployment || null;

    if (outcome) {
        if (outcome.success === true) {
            return 'SUCCESS';
        }

        const status = String(outcome.status || outcome.overallStatus || '')
            .trim()
            .toUpperCase();

        if (status === 'SUCCESS' || status === 'SUCCEEDED') {
            return 'SUCCESS';
        }

        return 'FAILED';
    }

    if (response.dependencyValidation?.overallStatus === 'BLOCKED') {
        return 'FAILED';
    }

    if (response.deploymentReadiness?.canDeploy === false) {
        return 'FAILED';
    }

    if (response.success === false) {
        return 'FAILED';
    }

    if (response.deploymentValidation?.destinationConnected === false) {
        return 'FAILED';
    }

    return 'FAILED';
}

function toSelectedMetadataItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const metadataType = item.metadataType || item.type || null;
    const metadataName = item.metadataName || item.name || null;

    if (!metadataType || !metadataName) {
        return null;
    }

    const selected = {
        metadataType,
        metadataName
    };

    if (item.filePath != null) {
        selected.filePath = item.filePath;
    }
    if (item.sourceExists != null) {
        selected.sourceExists = item.sourceExists;
    }
    if (item.artifactResolved != null) {
        selected.artifactResolved = item.artifactResolved;
    }
    if (item.apiVersion != null) {
        selected.apiVersion = item.apiVersion;
    }

    return selected;
}

/**
 * Build a validation-only package from the auto-fixed regenerated package.
 * Forces VALIDATE mode so deployment execution is never retried.
 */
function buildRevalidationPackage(deploymentPackage, autoFixResult) {
    const regenerated = autoFixResult?.generatedDeploymentPackage || null;
    const metadataItems = Array.isArray(regenerated?.metadata)
        ? regenerated.metadata
        : [];

    const selectedMetadata = metadataItems
        .map(toSelectedMetadataItem)
        .filter(Boolean);

    const base =
        deploymentPackage && typeof deploymentPackage === 'object'
            ? { ...deploymentPackage }
            : {};

    return {
        ...base,
        selectedMetadata,
        // Validation-only: never auto-retry DEPLOY execution.
        deploymentMode: 'VALIDATE',
        executeDeployment: false
    };
}

function buildAutoValidationReport({
    attempts,
    autoValidationExecuted,
    initialStatus,
    finalResponse,
    autoFixesApplied,
    revalidated
}) {
    const finalStatus = deriveValidationStatus(finalResponse);
    const report = {
        attempts: attempts || 1,
        autoValidationExecuted: autoValidationExecuted === true,
        initialStatus: initialStatus || finalStatus,
        finalStatus,
        autoFixesApplied: autoFixesApplied || 0,
        revalidated: revalidated === true
    };

    if (report.autoValidationExecuted && report.finalStatus !== 'SUCCESS') {
        report.remainingFailures = Array.isArray(
            finalResponse?.failureClassification?.failures
        )
            ? finalResponse.failureClassification.failures
            : [];
    }

    return report;
}

/**
 * Complete the validation response with at most one automatic re-validation.
 *
 * @param {object} params
 * @param {object} params.initialResponse First validation response
 * @param {object} params.autoFixResult Result from applyAutoFixes
 * @param {object|null} params.autoValidationContext Internal recursion guard
 * @param {object} params.deploymentPackage Original deployment package
 * @param {object} params.validationArgs { refreshToken, instanceUrl, orgId }
 * @param {Function} params.runValidation Injected validateDeployment (for tests)
 * @returns {Promise<object>} Final validation response
 */
async function completeWithAutoValidationLoop({
    initialResponse,
    autoFixResult,
    autoValidationContext = null,
    deploymentPackage,
    validationArgs = {},
    runValidation
}) {
    if (!initialResponse || typeof initialResponse !== 'object') {
        return initialResponse;
    }

    // Re-entry from the one allowed re-validation: parent attaches the report.
    if (isAutoValidationReentry(autoValidationContext)) {
        return initialResponse;
    }

    const autoFixReport = initialResponse.autoFixReport || {
        autoFixAvailable: false,
        autoFixApplied: false,
        fixes: []
    };

    if (
        !shouldRunAutoValidation({
            autoFixReport,
            autoValidationContext
        })
    ) {
        initialResponse.autoValidationReport = buildAutoValidationReport({
            attempts: 1,
            autoValidationExecuted: false,
            initialStatus: deriveValidationStatus(initialResponse),
            finalResponse: initialResponse,
            autoFixesApplied: countAutoFixesApplied(autoFixReport),
            revalidated: false
        });

        return initialResponse;
    }

    if (typeof runValidation !== 'function') {
        initialResponse.autoValidationReport = buildAutoValidationReport({
            attempts: 1,
            autoValidationExecuted: false,
            initialStatus: deriveValidationStatus(initialResponse),
            finalResponse: initialResponse,
            autoFixesApplied: countAutoFixesApplied(autoFixReport),
            revalidated: false
        });

        return initialResponse;
    }

    const initialStatus = deriveValidationStatus(initialResponse);
    const autoFixesApplied = countAutoFixesApplied(autoFixReport);
    const revalidationPackage = buildRevalidationPackage(
        deploymentPackage,
        autoFixResult
    );

    const finalResponse = await runValidation({
        refreshToken: validationArgs.refreshToken,
        instanceUrl: validationArgs.instanceUrl,
        orgId: validationArgs.orgId,
        deploymentPackage: revalidationPackage,
        autoValidationContext: {
            isRevalidation: true,
            attempt: MAX_VALIDATION_ATTEMPTS,
            initialStatus,
            autoFixesApplied
        }
    });

    if (!finalResponse || typeof finalResponse !== 'object') {
        initialResponse.autoValidationReport = buildAutoValidationReport({
            attempts: MAX_VALIDATION_ATTEMPTS,
            autoValidationExecuted: true,
            initialStatus,
            finalResponse: initialResponse,
            autoFixesApplied,
            revalidated: true
        });

        return initialResponse;
    }

    // Preserve first-pass auto-fix; keep final classification/resolution.
    finalResponse.autoFixReport = autoFixReport;

    if (!finalResponse.failureClassification) {
        finalResponse.failureClassification =
            initialResponse.failureClassification || null;
    }

    if (!finalResponse.resolutionReport) {
        finalResponse.resolutionReport =
            initialResponse.resolutionReport || null;
    }

    finalResponse.autoValidationReport = buildAutoValidationReport({
        attempts: MAX_VALIDATION_ATTEMPTS,
        autoValidationExecuted: true,
        initialStatus,
        finalResponse,
        autoFixesApplied,
        revalidated: true
    });

    return finalResponse;
}

module.exports = {
    MAX_VALIDATION_ATTEMPTS,
    isAutoValidationReentry,
    shouldRunAutoValidation,
    countAutoFixesApplied,
    deriveValidationStatus,
    buildRevalidationPackage,
    buildAutoValidationReport,
    completeWithAutoValidationLoop
};
