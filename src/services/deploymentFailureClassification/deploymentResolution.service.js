/**
 * Deployment Resolution Engine (Phase 17.2).
 *
 * READ-ONLY. Converts failureClassification (+ optional context) into
 * structured enterprise resolution recommendations.
 *
 * Never mutates metadata, package.xml, workspace, or deployment results.
 * Never retries, auto-fixes, or safe-skips.
 */

const RESOLUTION_TYPES = Object.freeze({
    DEPENDENCY: 'DEPENDENCY',
    PACKAGE: 'PACKAGE',
    WORKSPACE: 'WORKSPACE',
    RETRY: 'RETRY',
    ENABLE_FEATURE: 'ENABLE_FEATURE',
    MANUAL_METADATA_CHANGE: 'MANUAL_METADATA_CHANGE',
    MANUAL_CONFIGURATION: 'MANUAL_CONFIGURATION',
    INFORMATION: 'INFORMATION'
});

const EMPTY_SUMMARY = Object.freeze({
    autoFixAvailable: 0,
    safeSkipAvailable: 0,
    manualActions: 0,
    informational: 0,
    retryCandidates: 0
});

function emptyResolutionReport() {
    return {
        overallStatus: 'NONE',
        resolutions: [],
        summary: { ...EMPTY_SUMMARY }
    };
}

function normalizeText(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function packageContains(deploymentPackage, metadataType, metadataName) {
    if (!deploymentPackage || !metadataType || !metadataName) {
        return false;
    }

    const key = `${metadataType}:${metadataName}`.toLowerCase();
    const items = [
        ...(deploymentPackage.metadata || []),
        ...(deploymentPackage.dependencies || [])
    ];

    return items.some((item) => {
        const type = item?.metadataType || item?.type;
        const name = item?.metadataName || item?.name;
        return type && name && `${type}:${name}`.toLowerCase() === key;
    });
}

function buildResolution({
    metadataType,
    metadataName,
    category,
    resolutionType,
    severity,
    deterministic,
    autoFixAvailable,
    safeSkipAvailable,
    retryRecommended,
    userActionRequired,
    aiExplanationRecommended,
    title,
    summary,
    recommendation,
    documentationHint
}) {
    return {
        metadataType: metadataType || null,
        metadataName: metadataName || null,
        category: category || null,
        resolutionType,
        severity: severity || 'MEDIUM',
        deterministic: deterministic === true,
        autoFixAvailable: autoFixAvailable === true,
        safeSkipAvailable: safeSkipAvailable === true,
        retryRecommended: retryRecommended === true,
        userActionRequired: userActionRequired === true,
        aiExplanationRecommended: aiExplanationRecommended === true,
        title: title || null,
        summary: summary || null,
        recommendation: recommendation || null,
        documentationHint: documentationHint || null
    };
}

function mapFailureToResolution(failure, context = {}) {
    if (!failure) {
        return null;
    }

    const problem = normalizeText(
        failure.reason || failure.evidence?.problem || ''
    );
    const metadataType = failure.metadataType;
    const metadataName = failure.metadataName;
    const category = failure.category;
    const inPackage = packageContains(
        context.deploymentPackage,
        metadataType,
        metadataName
    );

    if (
        problem.includes('personaccount') ||
        problem.includes('person account') ||
        problem.includes('enable person accounts')
    ) {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.ENABLE_FEATURE,
            severity: 'HIGH',
            deterministic: true,
            autoFixAvailable: false,
            safeSkipAvailable: false,
            retryRecommended: false,
            userActionRequired: true,
            aiExplanationRecommended: true,
            title: 'Enable Person Accounts',
            summary:
                'Person Account RecordType access requires the Person Accounts feature in the destination org.',
            recommendation:
                'Enable Person Accounts in Setup, then retry deployment validation.',
            documentationHint:
                'Salesforce Help: Enable Person Accounts before deploying Person Account RecordType references.'
        });
    }

    if (
        problem.includes('formul') &&
        (problem.includes('type') ||
            problem.includes('convert') ||
            problem.includes('incompatible') ||
            problem.includes('compilation'))
    ) {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.MANUAL_METADATA_CHANGE,
            severity: 'HIGH',
            deterministic: true,
            autoFixAvailable: false,
            safeSkipAvailable: failure.canSafeSkip === true,
            retryRecommended: false,
            userActionRequired: true,
            aiExplanationRecommended: true,
            title: 'Formula or field type incompatibility',
            summary:
                'Salesforce Metadata API cannot apply this formula/field type change in place.',
            recommendation:
                'Recreate the field, migrate data manually, or deploy compatible field definitions only.',
            documentationHint:
                'See Salesforce field type conversion limitations for CustomField updates.'
        });
    }

    if (
        problem.includes('test') ||
        problem.includes('coverage') ||
        problem.includes('code coverage')
    ) {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.MANUAL_METADATA_CHANGE,
            severity: 'HIGH',
            deterministic: true,
            autoFixAvailable: false,
            safeSkipAvailable: false,
            retryRecommended: false,
            userActionRequired: true,
            aiExplanationRecommended: true,
            title: 'Apex test or coverage failure',
            summary: 'Deployment requires passing Apex tests and coverage thresholds.',
            recommendation:
                'Fix failing tests or increase coverage, then retry deployment.',
            documentationHint:
                'Salesforce requires adequate Apex test coverage for production deployments.'
        });
    }

    if (
        problem.includes('timeout') ||
        problem.includes('try again') ||
        problem.includes('transient') ||
        problem.includes('econnreset') ||
        problem.includes('socket hang up') ||
        problem.includes('temporarily unavailable') ||
        (failure.deterministic === false &&
            normalizeText(failure.recommendedNextStep).includes('retry'))
    ) {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.RETRY,
            severity: 'MEDIUM',
            deterministic: false,
            autoFixAvailable: false,
            safeSkipAvailable: false,
            retryRecommended: true,
            userActionRequired: false,
            aiExplanationRecommended: true,
            title: 'Retry candidate',
            summary: 'The failure appears transient and may succeed on retry.',
            recommendation: 'Retry deployment validation without changing metadata.',
            documentationHint:
                'Transient CLI/network errors are often resolved by retrying the same package.'
        });
    }

    if (
        problem.includes('workspace') ||
        problem.includes('tabset') ||
        (problem.includes('flexipage') && problem.includes('label'))
    ) {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.WORKSPACE,
            severity: 'MEDIUM',
            deterministic: true,
            autoFixAvailable: failure.canAutoFix === true,
            safeSkipAvailable: false,
            retryRecommended: false,
            userActionRequired: failure.canAutoFix !== true,
            aiExplanationRecommended: false,
            title: 'Workspace compatibility issue',
            summary:
                'A workspace-local compatibility issue was detected for this component.',
            recommendation:
                'Review workspace compatibility rules; auto-fix is not applied by the Resolution Engine.',
            documentationHint:
                'Existing metadataCompatibility rules may address known FlexiPage workspace issues.'
        });
    }

    if (
        problem.includes('not included') ||
        problem.includes('not in the package') ||
        problem.includes('add this dependency to the deployment package') ||
        (problem.includes('missing') && !inPackage)
    ) {
        const missingFromPackage =
            metadataType && metadataName && !inPackage;

        if (missingFromPackage || problem.includes('package')) {
            return buildResolution({
                metadataType,
                metadataName,
                category,
                resolutionType: RESOLUTION_TYPES.PACKAGE,
                severity: 'HIGH',
                deterministic: true,
                autoFixAvailable: false,
                safeSkipAvailable: failure.canSafeSkip === true,
                retryRecommended: false,
                userActionRequired: true,
                aiExplanationRecommended: true,
                title: 'Missing package member',
                summary:
                    'Required metadata is not present in the generated deployment package.',
                recommendation:
                    'Ensure dependency discovery includes this member, or select it explicitly before deploy.',
                documentationHint:
                    'package.xml must include every metadata member Salesforce validates as a cross-reference.'
            });
        }
    }

    if (
        problem.includes('unable to find') ||
        problem.includes('dependency') ||
        problem.includes('invalid cross reference') ||
        problem.includes('not found in destination') ||
        failure.evidence?.source === 'DEPENDENCY_VALIDATION'
    ) {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.DEPENDENCY,
            severity: 'HIGH',
            deterministic: failure.deterministic === true,
            autoFixAvailable: false,
            safeSkipAvailable: failure.canSafeSkip === true,
            retryRecommended: false,
            userActionRequired: true,
            aiExplanationRecommended: true,
            title: 'Missing dependency',
            summary:
                'A required dependency is unavailable in the destination or deployment set.',
            recommendation:
                failure.recommendedNextStep ||
                'Deploy or create the missing dependency, then retry validation.',
            documentationHint:
                'Resolve dependency graph gaps before deploying dependent PermissionSets or referencing metadata.'
        });
    }

    if (
        category === 'INFORMATION' ||
        failure.evidence?.source === 'CLI_WARNING' ||
        (failure.evidence?.source === 'COMPATIBILITY' &&
            !failure.requiresUserAction)
    ) {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.INFORMATION,
            severity: 'LOW',
            deterministic: true,
            autoFixAvailable: false,
            safeSkipAvailable: false,
            retryRecommended: false,
            userActionRequired: false,
            aiExplanationRecommended: false,
            title: 'Informational warning',
            summary: failure.reason || 'Informational deployment warning.',
            recommendation:
                failure.recommendedNextStep ||
                'No deployment action required.',
            documentationHint: null
        });
    }

    if (category === 'SAFE_SKIP') {
        return buildResolution({
            metadataType,
            metadataName,
            category,
            resolutionType: RESOLUTION_TYPES.PACKAGE,
            severity: 'MEDIUM',
            deterministic: true,
            autoFixAvailable: false,
            safeSkipAvailable: true,
            retryRecommended: false,
            userActionRequired: false,
            aiExplanationRecommended: false,
            title: 'Safe skip candidate',
            summary:
                'This non-selected component may be excluded without changing user-selected metadata.',
            recommendation:
                'Safe skip is recommended only; the Resolution Engine does not apply exclusions.',
            documentationHint:
                'Existing compatibility package filter already auto-excludes known incompatible categories.'
        });
    }

    return buildResolution({
        metadataType,
        metadataName,
        category,
        resolutionType: RESOLUTION_TYPES.MANUAL_CONFIGURATION,
        severity: 'MEDIUM',
        deterministic: failure.deterministic === true,
        autoFixAvailable: false,
        safeSkipAvailable: failure.canSafeSkip === true,
        retryRecommended: false,
        userActionRequired: failure.requiresUserAction !== false,
        aiExplanationRecommended: failure.aiExplanationUseful === true,
        title: 'Manual configuration required',
        summary: failure.reason || 'Manual remediation is required.',
        recommendation:
            failure.recommendedNextStep ||
            'Review the failure and resolve it in Salesforce Setup or source metadata.',
        documentationHint: null
    });
}

function buildSummary(resolutions) {
    const summary = { ...EMPTY_SUMMARY };

    for (const resolution of resolutions) {
        if (resolution.autoFixAvailable) {
            summary.autoFixAvailable += 1;
        }

        if (resolution.safeSkipAvailable) {
            summary.safeSkipAvailable += 1;
        }

        if (resolution.userActionRequired) {
            summary.manualActions += 1;
        }

        if (resolution.resolutionType === RESOLUTION_TYPES.INFORMATION) {
            summary.informational += 1;
        }

        if (resolution.retryRecommended) {
            summary.retryCandidates += 1;
        }
    }

    return summary;
}

/**
 * Build a read-only resolution report from failure classification.
 *
 * @param {object} context
 * @returns {{ overallStatus: string, resolutions: object[], summary: object }}
 */
function buildResolutionReport({
    failureClassification = null,
    deploymentDiagnostics = null,
    dependencyResolutionSummary = null,
    dependencyValidation = null,
    deploymentCompatibility = null,
    deploymentPackage = null,
    selectedMetadata = []
} = {}) {
    void deploymentDiagnostics;
    void dependencyResolutionSummary;
    void dependencyValidation;
    void deploymentCompatibility;
    void selectedMetadata;

    const failures = Array.isArray(failureClassification?.failures)
        ? failureClassification.failures
        : [];

    if (!failures.length) {
        return emptyResolutionReport();
    }

    const resolutions = [];

    for (const failure of failures) {
        const resolution = mapFailureToResolution(failure, {
            deploymentPackage
        });

        if (resolution) {
            resolutions.push(resolution);
        }
    }

    return {
        overallStatus: resolutions.length ? 'RESOLVED' : 'NONE',
        resolutions,
        summary: buildSummary(resolutions)
    };
}

module.exports = {
    RESOLUTION_TYPES,
    buildResolutionReport,
    emptyResolutionReport,
    mapFailureToResolution
};
