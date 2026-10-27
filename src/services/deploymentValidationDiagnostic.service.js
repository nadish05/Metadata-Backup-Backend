/**
 * Compact stdout diagnostics for deployment validation (formula exclusion + failure merge).
 * Logging only — does not change validation behavior.
 */

'use strict';

const {
    isEligibleShapeFormulaAutoExcludeWarning,
    isShapePolicyExclusion
} = require('./deploymentShapeFormulaExclusionPolicy.service');
const { itemKey, collectPackageComponents } = require('./deploymentReadiness.service');

const LOG_PREFIX = 'DEPLOY_VALIDATION_DIAG';

const TARGET_CUSTOM_FIELDS = Object.freeze([
    'Session__c.End_Time__c',
    'Session__c.Status__c'
]);

function resolveBackendBuildId() {
    const raw = process.env.GIT_COMMIT;

    if (typeof raw === 'string' && raw.trim().length > 0) {
        return raw.trim();
    }

    return 'unknown';
}

function normalizeCalculated(value) {
    if (value === true) {
        return true;
    }

    if (value === false) {
        return false;
    }

    return null;
}

function findWarningForField(compatibilityWarnings, metadataName) {
    const warnings = Array.isArray(compatibilityWarnings)
        ? compatibilityWarnings
        : [];

    return (
        warnings.find(
            (warning) =>
                String(warning?.metadataType || 'CustomField') ===
                    'CustomField' &&
                warning?.metadataName === metadataName
        ) || null
    );
}

function packageContainsField(deploymentPackage, metadataName) {
    if (!deploymentPackage || !metadataName) {
        return null;
    }

    const key = itemKey('CustomField', metadataName);
    const members = collectPackageComponents(deploymentPackage);

    return members.some(
        (component) =>
            itemKey(component.metadataType, component.metadataName) === key
    );
}

function manifestContainsField(packageXml, metadataName) {
    if (typeof packageXml !== 'string' || !metadataName) {
        return null;
    }

    return packageXml.includes(metadataName);
}

function fieldWasExcluded(excludedComponents, metadataName) {
    const excluded = Array.isArray(excludedComponents)
        ? excludedComponents
        : [];

    return excluded.some(
        (item) =>
            item?.metadataName === metadataName &&
            String(item?.metadataType || 'CustomField') === 'CustomField'
    );
}

function shapePolicyExcluded(excludedComponents, metadataName) {
    const excluded = Array.isArray(excludedComponents)
        ? excludedComponents
        : [];

    return excluded.some(
        (item) =>
            item?.metadataName === metadataName && isShapePolicyExclusion(item)
    );
}

function collectCheckOnlyFailures(checkOnlyDeployment, metadataName) {
    const failures =
        checkOnlyDeployment?.deploymentDiagnostics?.componentFailures || [];

    if (!Array.isArray(failures)) {
        return [];
    }

    return failures
        .filter((failure) => {
            const name =
                failure?.metadataName ||
                failure?.fullName ||
                failure?.componentName ||
                null;

            return name === metadataName;
        })
        .map((failure) => ({
            metadataType: failure?.metadataType || null,
            metadataName:
                failure?.metadataName ||
                failure?.fullName ||
                failure?.componentName ||
                null,
            problem: failure?.problem || null
        }));
}

function failureEntriesForField(failureClassification, metadataName) {
    const failures = Array.isArray(failureClassification?.failures)
        ? failureClassification.failures
        : [];
    const key = itemKey('CustomField', metadataName);

    return failures.filter(
        (failure) =>
            failure?.key === key ||
            (failure?.metadataType === 'CustomField' &&
                failure?.metadataName === metadataName)
    );
}

function mergedCliCompatibility(failure) {
    const sources = failure?.evidence?.sources;

    if (!Array.isArray(sources)) {
        return false;
    }

    const normalized = sources.map((value) => String(value).toUpperCase());

    return (
        normalized.includes('CLI') && normalized.includes('COMPATIBILITY')
    );
}

function buildTargetFieldDiagnostics({
    metadataName,
    compatibilityWarnings,
    excludedComponents,
    deploymentPackage,
    packageXml,
    failureClassification,
    checkOnlyDeployment
}) {
    const warning = findWarningForField(compatibilityWarnings, metadataName);
    const facts = warning?.conflictFacts;
    const failures = failureEntriesForField(
        failureClassification,
        metadataName
    );

    const inFinalPackage = packageContainsField(
        deploymentPackage,
        metadataName
    );
    const inManifest = manifestContainsField(packageXml, metadataName);
    const excluded = fieldWasExcluded(excludedComponents, metadataName);
    const excludedByShapePolicy = shapePolicyExcluded(
        excludedComponents,
        metadataName
    );

    let exclusionEligible = null;

    if (warning) {
        exclusionEligible = isEligibleShapeFormulaAutoExcludeWarning(warning);
    }

    return {
        metadataName,
        sourceCalculated: facts
            ? normalizeCalculated(facts.source?.calculated)
            : null,
        destinationCalculated: facts
            ? normalizeCalculated(facts.destination?.calculated)
            : null,
        warningDetectionSource: warning?.detectionSource ?? null,
        exclusionEligible,
        excluded,
        excludedByShapePolicy,
        inFinalPackage,
        inManifest,
        checkOnlyFailures: collectCheckOnlyFailures(
            checkOnlyDeployment,
            metadataName
        ),
        failureClassification: failures.map((failure) => ({
            key: failure?.key ?? null,
            category: failure?.category ?? null,
            reason: failure?.reason ?? null,
            evidenceSource: failure?.evidence?.source ?? null,
            evidenceSources: Array.isArray(failure?.evidence?.sources)
                ? [...failure.evidence.sources]
                : null,
            cliCompatibilityMerged: mergedCliCompatibility(failure)
        })),
        failureEntryCount: failures.length
    };
}

function resolveCheckOnlySkipped(checkOnlyDeployment) {
    if (!checkOnlyDeployment || typeof checkOnlyDeployment !== 'object') {
        return { skipped: null, reason: null };
    }

    if (
        checkOnlyDeployment.executed === false ||
        String(checkOnlyDeployment.status || '').toUpperCase() === 'NOT_EXECUTED'
    ) {
        return {
            skipped: true,
            reason:
                checkOnlyDeployment.skipReason ||
                checkOnlyDeployment.message ||
                null
        };
    }

    if (checkOnlyDeployment.executed === true) {
        return { skipped: false, reason: null };
    }

    return { skipped: null, reason: null };
}

/**
 * Build compact diagnostic payload from the final validation response.
 *
 * @param {object} params
 * @returns {object}
 */
function buildDeploymentValidationDiagnostic({
    validationId = null,
    validationPass = 'primary',
    completedAt = null,
    finalResponse = null,
    compatibilityFilterError = null
} = {}) {
    const response =
        finalResponse && typeof finalResponse === 'object'
            ? finalResponse
            : {};

    const scope = response.deploymentValidationScope || {};
    const policy =
        response.shapeFormulaExclusionPolicy ||
        scope.shapeFormulaExclusionPolicy ||
        {};
    const compatibilityWarnings =
        response.compatibilityWarnings ||
        response.deploymentCompatibilityPlan?.compatibilityWarnings ||
        [];
    const excludedComponents =
        response.excludedComponents ||
        response.compatibilityPackageFilter?.excludedComponents ||
        [];
    const deploymentPackage = response.generatedDeploymentPackage || null;
    const packageXml = response.generatedManifest?.packageXml ?? null;
    const checkOnlyDeployment = response.checkOnlyDeployment || null;
    const checkOnlySkip = resolveCheckOnlySkipped(checkOnlyDeployment);

    const autoExclude =
        scope.autoExcludeShapeFormulaConflicts === true
            ? true
            : scope.autoExcludeShapeFormulaConflicts === false
              ? false
              : policy.enabled === true
                ? true
                : policy.enabled === false
                  ? false
                  : null;

    const beforeFilter =
        scope.packageComponentCountBeforeFilter ??
        response.packageComponentCountBeforeFilter ??
        null;
    const afterFilter =
        scope.packageComponentCountAfterFilter ??
        response.packageComponentCountAfterFilter ??
        null;

    return {
        event: 'deployment.validation.completed',
        validationId: validationId || null,
        validationPass,
        completedAt: completedAt || new Date().toISOString(),
        backendBuildId: resolveBackendBuildId(),
        autoExcludeShapeFormulaConflicts: autoExclude,
        shapePolicy: {
            enabled: policy.enabled === true
                ? true
                : policy.enabled === false
                  ? false
                  : null,
            applied: policy.applied === true
                ? true
                : policy.applied === false
                  ? false
                  : null,
            revertedDueToBlockingDependencies:
                policy.revertedDueToBlockingDependencies === true
                    ? true
                    : policy.revertedDueToBlockingDependencies === false
                      ? false
                      : null,
            suppressedExclusions: Array.isArray(policy.suppressedExclusions)
                ? policy.suppressedExclusions.map((item) => ({
                      metadataType: item?.metadataType ?? null,
                      metadataName: item?.metadataName ?? null,
                      reason: item?.reason ?? null,
                      category: item?.category ?? null
                  }))
                : null,
            blockedDependents: Array.isArray(policy.blockedDependents)
                ? policy.blockedDependents.map((item) => ({
                      metadataType: item?.metadataType ?? null,
                      metadataName: item?.metadataName ?? null,
                      message: item?.message ?? item?.reason ?? null,
                      category: item?.category ?? null
                  }))
                : null
        },
        packageCounts: {
            beforeFilter,
            afterFilter
        },
        targetFields: TARGET_CUSTOM_FIELDS.map((metadataName) =>
            buildTargetFieldDiagnostics({
                metadataName,
                compatibilityWarnings,
                excludedComponents,
                deploymentPackage,
                packageXml,
                failureClassification: response.failureClassification,
                checkOnlyDeployment
            })
        ),
        compatibilityFilterError:
            compatibilityFilterError === true
                ? true
                : compatibilityFilterError === false
                  ? false
                  : null,
        checkOnly: {
            executed:
                checkOnlyDeployment?.executed === true
                    ? true
                    : checkOnlyDeployment?.executed === false
                      ? false
                      : null,
            success:
                checkOnlyDeployment?.success === true
                    ? true
                    : checkOnlyDeployment?.success === false
                      ? false
                      : null
        },
        checkOnlySkipped: checkOnlySkip.skipped,
        checkOnlySkippedReason: checkOnlySkip.reason
    };
}

function logDeploymentValidationDiagnostic(record) {
    if (!record || typeof record !== 'object') {
        return;
    }

    console.log(LOG_PREFIX, JSON.stringify(record));
}

module.exports = {
    LOG_PREFIX,
    TARGET_CUSTOM_FIELDS,
    resolveBackendBuildId,
    buildDeploymentValidationDiagnostic,
    logDeploymentValidationDiagnostic
};
