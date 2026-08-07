/**
 * Deployment Failure Classification (Phase 17.2).
 *
 * READ-ONLY. Converts deploy diagnostics and pre-deploy context into
 * structured failure categories. Never mutates package, workspace, CLI
 * results, or deployment behavior.
 */

const CATEGORIES = Object.freeze({
    AUTO_FIX: 'AUTO_FIX',
    SAFE_SKIP: 'SAFE_SKIP',
    MANUAL_ACTION: 'MANUAL_ACTION',
    INFORMATION: 'INFORMATION'
});

const EMPTY_SUMMARY = Object.freeze({
    autoFix: 0,
    safeSkip: 0,
    manualAction: 0,
    information: 0,
    unclassified: 0
});

function emptyClassification() {
    return {
        overallStatus: 'NONE',
        failures: [],
        summary: { ...EMPTY_SUMMARY }
    };
}

function getType(item) {
    return item?.metadataType || item?.type || null;
}

function getName(item) {
    return (
        item?.metadataName ||
        item?.name ||
        item?.componentName ||
        item?.fullName ||
        null
    );
}

function failureKey(type, name) {
    if (!type && !name) {
        return null;
    }

    return `${type || 'Unknown'}:${name || 'Unknown'}`;
}

function normalizeProblem(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function isUserSelected(selectedMetadata, metadataType, metadataName) {
    if (!Array.isArray(selectedMetadata) || !metadataType || !metadataName) {
        return false;
    }

    const key = failureKey(metadataType, metadataName).toLowerCase();

    return selectedMetadata.some((item) => {
        const itemKey = failureKey(getType(item), getName(item));
        return itemKey && itemKey.toLowerCase() === key;
    });
}

function buildFailure({
    metadataType,
    metadataName,
    category,
    confidence,
    deterministic,
    canAutoFix,
    canSafeSkip,
    requiresUserAction,
    aiExplanationUseful,
    reason,
    evidence,
    recommendedNextStep
}) {
    return {
        key: failureKey(metadataType, metadataName),
        metadataType: metadataType || null,
        metadataName: metadataName || null,
        category,
        confidence,
        deterministic: deterministic === true,
        canAutoFix: canAutoFix === true,
        canSafeSkip: canSafeSkip === true,
        requiresUserAction: requiresUserAction === true,
        aiExplanationUseful: aiExplanationUseful === true,
        reason: reason || null,
        evidence: evidence || null,
        recommendedNextStep: recommendedNextStep || null
    };
}

function classifyProblemText({
    problem,
    metadataType,
    metadataName,
    selectedMetadata
}) {
    const text = normalizeProblem(problem);
    const userSelected = isUserSelected(
        selectedMetadata,
        metadataType,
        metadataName
    );

    if (!text) {
        return null;
    }

    if (
        text.includes('personaccount') ||
        (text.includes('recordtype') && text.includes('personaccount')) ||
        text.includes('enable person accounts')
    ) {
        return buildFailure({
            metadataType,
            metadataName,
            category: CATEGORIES.MANUAL_ACTION,
            confidence: 'HIGH',
            deterministic: true,
            canAutoFix: false,
            canSafeSkip: false,
            requiresUserAction: true,
            aiExplanationUseful: true,
            reason:
                'Person Account RecordType is unavailable in the destination org.',
            evidence: { problem, source: 'CLI' },
            recommendedNextStep: 'Enable Person Accounts in the destination org.'
        });
    }

    if (
        text.includes('formul') &&
        (text.includes('type') ||
            text.includes('convert') ||
            text.includes('incompatible'))
    ) {
        return buildFailure({
            metadataType,
            metadataName,
            category: userSelected
                ? CATEGORIES.MANUAL_ACTION
                : CATEGORIES.SAFE_SKIP,
            confidence: 'HIGH',
            deterministic: true,
            canAutoFix: false,
            canSafeSkip: !userSelected,
            requiresUserAction: userSelected,
            aiExplanationUseful: true,
            reason: 'Formula or field type conversion is not supported by Metadata API deploy.',
            evidence: { problem, source: 'CLI' },
            recommendedNextStep:
                'Recreate the field or migrate data manually in the destination org.'
        });
    }

    if (
        text.includes('unable to find') ||
        text.includes('no recordtype named') ||
        text.includes('invalid cross reference') ||
        text.includes('depends on') ||
        text.includes('missing')
    ) {
        const looksLikePackageGap =
            text.includes('not found in') === false &&
            (text.includes('unable to find') ||
                text.includes('invalid cross reference'));

        return buildFailure({
            metadataType,
            metadataName,
            category: CATEGORIES.MANUAL_ACTION,
            confidence: 'MEDIUM',
            deterministic: true,
            canAutoFix: false,
            canSafeSkip: !userSelected,
            requiresUserAction: true,
            aiExplanationUseful: true,
            reason: looksLikePackageGap
                ? 'Referenced metadata is missing from the destination or deployment package.'
                : 'A required dependency is missing for this component.',
            evidence: { problem, source: 'CLI' },
            recommendedNextStep:
                'Add the missing dependency to the package or create it in the destination org.'
        });
    }

    if (
        text.includes('timeout') ||
        text.includes('try again') ||
        text.includes('unable to parse') ||
        text.includes('econnreset') ||
        text.includes('socket hang up') ||
        text.includes('temporarily unavailable')
    ) {
        return buildFailure({
            metadataType,
            metadataName,
            category: CATEGORIES.INFORMATION,
            confidence: 'MEDIUM',
            deterministic: false,
            canAutoFix: false,
            canSafeSkip: false,
            requiresUserAction: false,
            aiExplanationUseful: true,
            reason: 'Transient CLI or network failure detected.',
            evidence: { problem, source: 'CLI' },
            recommendedNextStep: 'Retry the deployment validation.'
        });
    }

    return buildFailure({
        metadataType,
        metadataName,
        category: CATEGORIES.MANUAL_ACTION,
        confidence: 'LOW',
        deterministic: false,
        canAutoFix: false,
        canSafeSkip: false,
        requiresUserAction: true,
        aiExplanationUseful: true,
        reason: problem || 'Unclassified Salesforce deployment failure.',
        evidence: { problem, source: 'CLI' },
        recommendedNextStep: 'Review the Salesforce error and resolve manually.'
    });
}

function classifyCompatibilityWarning(warning, selectedMetadata) {
    const metadataType = getType(warning);
    const metadataName = getName(warning);
    const categoryName = String(warning?.category || '').toUpperCase();
    const userSelected = isUserSelected(
        selectedMetadata,
        metadataType,
        metadataName
    );

    if (
        categoryName === 'FORMULA_TYPE_CHANGE' ||
        categoryName === 'FORMULA_COMPILATION' ||
        categoryName === 'FIELD_TYPE_CHANGE' ||
        categoryName === 'PICKLIST_TYPE_CHANGE'
    ) {
        return buildFailure({
            metadataType,
            metadataName,
            category: userSelected
                ? CATEGORIES.MANUAL_ACTION
                : CATEGORIES.SAFE_SKIP,
            confidence: 'HIGH',
            deterministic: true,
            canAutoFix: false,
            canSafeSkip: !userSelected,
            requiresUserAction: userSelected,
            aiExplanationUseful: true,
            reason:
                warning?.message ||
                `Compatibility category ${categoryName} requires remediation.`,
            evidence: {
                problem: warning?.message || categoryName,
                problemType: categoryName,
                source: 'COMPATIBILITY'
            },
            recommendedNextStep:
                'Resolve the incompatible field change or exclude non-selected components.'
        });
    }

    if (categoryName) {
        return buildFailure({
            metadataType,
            metadataName,
            category: CATEGORIES.INFORMATION,
            confidence: 'MEDIUM',
            deterministic: true,
            canAutoFix: false,
            canSafeSkip: false,
            requiresUserAction: false,
            aiExplanationUseful: false,
            reason: warning?.message || `Compatibility warning: ${categoryName}`,
            evidence: {
                problem: warning?.message || categoryName,
                problemType: categoryName,
                source: 'COMPATIBILITY'
            },
            recommendedNextStep: 'Review the compatibility warning.'
        });
    }

    return null;
}

function classifyDependencyValidationRow(row) {
    if (!row || row.status !== 'BLOCKED') {
        return null;
    }

    return buildFailure({
        metadataType: getType(row),
        metadataName: getName(row),
        category: CATEGORIES.MANUAL_ACTION,
        confidence: 'HIGH',
        deterministic: true,
        canAutoFix: false,
        canSafeSkip: false,
        requiresUserAction: true,
        aiExplanationUseful: true,
        reason:
            row.message ||
            'Dependency is missing from the destination and not included in the package.',
        evidence: {
            problem: row.message || row.status,
            source: 'DEPENDENCY_VALIDATION'
        },
        recommendedNextStep:
            'Include the dependency in the deployment package or create it in the destination.'
    });
}

function collectCliFailures(deploymentDiagnostics, deployOutcome) {
    const diagnostics =
        deploymentDiagnostics?.componentFailures ||
        deployOutcome?.deploymentDiagnostics?.componentFailures ||
        [];
    const details = deployOutcome?.failureDetails || [];

    if (Array.isArray(diagnostics) && diagnostics.length) {
        return diagnostics.map((failure) => ({
            metadataType: failure.metadataType || null,
            metadataName:
                failure.metadataName ||
                failure.fullName ||
                failure.componentName ||
                null,
            problem: failure.problem || null
        }));
    }

    return details.map((failure) => ({
        metadataType: failure.metadataType || null,
        metadataName: failure.componentName || failure.metadataName || null,
        problem: failure.problem || null
    }));
}

function buildSummary(failures) {
    const summary = { ...EMPTY_SUMMARY };

    for (const failure of failures) {
        switch (failure.category) {
            case CATEGORIES.AUTO_FIX:
                summary.autoFix += 1;
                break;
            case CATEGORIES.SAFE_SKIP:
                summary.safeSkip += 1;
                break;
            case CATEGORIES.MANUAL_ACTION:
                summary.manualAction += 1;
                break;
            case CATEGORIES.INFORMATION:
                summary.information += 1;
                break;
            default:
                summary.unclassified += 1;
                break;
        }
    }

    return summary;
}

/**
 * Classify deployment failures without mutating inputs or deployment state.
 *
 * @param {object} context
 * @returns {{ overallStatus: string, failures: object[], summary: object }}
 */
function classifyDeploymentFailures({
    deploymentDiagnostics = null,
    deployOutcome = null,
    dependencyValidation = null,
    deploymentCompatibilityPlan = null,
    compatibilityWarnings = null,
    selectedMetadata = []
} = {}) {
    const failures = [];
    const seen = new Set();

    function addFailure(failure) {
        if (!failure) {
            return;
        }

        const dedupeKey = `${failure.key}:${failure.category}:${failure.reason || ''}`;

        if (seen.has(dedupeKey)) {
            return;
        }

        seen.add(dedupeKey);
        failures.push(failure);
    }

    for (const cliFailure of collectCliFailures(
        deploymentDiagnostics,
        deployOutcome
    )) {
        addFailure(
            classifyProblemText({
                problem: cliFailure.problem,
                metadataType: cliFailure.metadataType,
                metadataName: cliFailure.metadataName,
                selectedMetadata
            })
        );
    }

    const warnings = [
        ...(Array.isArray(compatibilityWarnings) ? compatibilityWarnings : []),
        ...(Array.isArray(deploymentCompatibilityPlan?.compatibilityWarnings)
            ? deploymentCompatibilityPlan.compatibilityWarnings
            : [])
    ];

    for (const warning of warnings) {
        addFailure(classifyCompatibilityWarning(warning, selectedMetadata));
    }

    for (const row of dependencyValidation?.results || []) {
        addFailure(classifyDependencyValidationRow(row));
    }

    for (const warning of deployOutcome?.warnings || []) {
        const text =
            typeof warning === 'string'
                ? warning
                : warning?.message || warning?.problem || null;

        if (!text) {
            continue;
        }

        addFailure(
            buildFailure({
                metadataType: warning?.metadataType || null,
                metadataName: warning?.metadataName || null,
                category: CATEGORIES.INFORMATION,
                confidence: 'HIGH',
                deterministic: true,
                canAutoFix: false,
                canSafeSkip: false,
                requiresUserAction: false,
                aiExplanationUseful: false,
                reason: text,
                evidence: { problem: text, source: 'CLI_WARNING' },
                recommendedNextStep: 'Informational only; no deployment action required.'
            })
        );
    }

    if (
        deployOutcome &&
        deployOutcome.success === false &&
        (!deployOutcome.failureDetails ||
            deployOutcome.failureDetails.length === 0) &&
        (!deployOutcome.deploymentDiagnostics?.componentFailures ||
            deployOutcome.deploymentDiagnostics.componentFailures.length ===
                0) &&
        deployOutcome.message
    ) {
        addFailure(
            classifyProblemText({
                problem: deployOutcome.message,
                metadataType: null,
                metadataName: null,
                selectedMetadata
            })
        );
    }

    const summary = buildSummary(failures);

    return {
        overallStatus: failures.length ? 'CLASSIFIED' : 'NONE',
        failures,
        summary
    };
}

module.exports = {
    CATEGORIES,
    classifyDeploymentFailures,
    emptyClassification
};
