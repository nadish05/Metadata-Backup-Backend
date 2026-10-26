/**
 * Phase 2 — Opt-in auto-exclusion for shape-confirmed destination-formula conflicts.
 *
 * Uses existing compatibility filter + dependency-impact analysis.
 * Reverts shape exclusions when impact reports blocking dependents.
 */

'use strict';

const deploymentCompatibilityFilterService = require('./deploymentCompatibilityFilter.service');
const deploymentCompatibilityImpactService = require('./deploymentCompatibilityImpact.service');
const {
    collectPackageComponents,
    itemKey: packageItemKey
} = require('./deploymentReadiness.service');

const RESIDUAL_DISCOVERY_RISK_NOTE =
    'Dependency-impact analysis only considers relationships captured in the deployment discovery graph. ' +
    'An empty blocker list does not prove that excluding a field is safe; metadata may still reference excluded fields without a recorded edge.';

const SHAPE_DETECTION_SOURCE = 'SHAPE_INDEX';
const EXCLUSION_SOURCE_SHAPE_POLICY = 'SHAPE_FORMULA_POLICY';

/**
 * Resolve autoExcludeShapeFormulaConflicts for validation.
 *
 * Contract:
 * 1. If top-level request value is an explicit boolean, it wins.
 * 2. Else if deploymentPackage value is an explicit boolean, use it.
 * 3. Else default false (strings/numbers never enable the policy).
 */
function resolveAutoExcludeShapeFormulaConflictsPolicy({
    topLevel = undefined,
    deploymentPackage = null
} = {}) {
    if (typeof topLevel === 'boolean') {
        return topLevel;
    }

    const packageLevel = deploymentPackage?.autoExcludeShapeFormulaConflicts;

    if (typeof packageLevel === 'boolean') {
        return packageLevel;
    }

    return false;
}

/** @deprecated Use resolveAutoExcludeShapeFormulaConflictsPolicy after request merge. */
function parseAutoExcludeShapeFormulaConflictsPolicy(deploymentPackage) {
    return resolveAutoExcludeShapeFormulaConflictsPolicy({
        deploymentPackage
    });
}

function isEligibleShapeFormulaAutoExcludeWarning(warning) {
    if (!warning || warning.detectionSource !== SHAPE_DETECTION_SOURCE) {
        return false;
    }

    if (warning.metadataType !== 'CustomField') {
        return false;
    }

    if (!warning.metadataName) {
        return false;
    }

    const facts = warning.conflictFacts;

    if (!facts || typeof facts !== 'object') {
        return false;
    }

    if (facts.source?.calculated !== false) {
        return false;
    }

    if (facts.destination?.calculated !== true) {
        return false;
    }

    return true;
}

function augmentCompatibilityWarningsForShapePolicy(
    compatibilityWarnings,
    policyEnabled
) {
    const warnings = Array.isArray(compatibilityWarnings)
        ? compatibilityWarnings
        : [];

    if (!policyEnabled) {
        return warnings;
    }

    return warnings.map((warning) => {
        if (!isEligibleShapeFormulaAutoExcludeWarning(warning)) {
            return warning;
        }

        return {
            ...warning,
            autoExclude: true,
            exclusionPolicy: 'SHAPE_DESTINATION_FORMULA'
        };
    });
}

function isShapePolicyExclusion(excludedComponent) {
    return (
        excludedComponent?.exclusionSource === EXCLUSION_SOURCE_SHAPE_POLICY ||
        excludedComponent?.exclusionPolicy === 'SHAPE_DESTINATION_FORMULA'
    );
}

function countUniquePackageMembers(deploymentPackage) {
    return collectPackageComponents(deploymentPackage).length;
}

function collectUnresolvedShapeFormulaConflicts(
    compatibilityWarnings,
    deploymentPackage
) {
    const memberKeys = new Set(
        collectPackageComponents(deploymentPackage).map((component) =>
            packageItemKey(component.metadataType, component.metadataName)
        )
    );
    const unresolved = [];

    for (const warning of compatibilityWarnings || []) {
        if (!isEligibleShapeFormulaAutoExcludeWarning(warning)) {
            continue;
        }

        const key = packageItemKey(
            warning.metadataType || 'CustomField',
            warning.metadataName
        );

        if (key && memberKeys.has(key)) {
            unresolved.push({
                metadataType: warning.metadataType || 'CustomField',
                metadataName: warning.metadataName,
                message: warning.message || null,
                detectionSource: warning.detectionSource || SHAPE_DETECTION_SOURCE
            });
        }
    }

    return unresolved;
}

function countSelectedComponents(deploymentPackage) {
    const selected = deploymentPackage?.selectedMetadata;

    if (!Array.isArray(selected)) {
        return null;
    }

    const seen = new Set();

    for (const item of selected) {
        const type = item?.metadataType || item?.type;
        const name = item?.metadataName || item?.name;

        if (!type || !name) {
            continue;
        }

        seen.add(`${type}:${name}`);
    }

    return seen.size;
}

function annotateShapeExclusions(excludedComponents) {
    return (excludedComponents || []).map((component) => {
        if (!isShapePolicyExclusion(component)) {
            return component;
        }

        return {
            ...component,
            exclusionSource:
                component.exclusionSource || EXCLUSION_SOURCE_SHAPE_POLICY
        };
    });
}

/**
 * Run compatibility filter with optional shape auto-exclude and safety revert.
 */
function applyCompatibilityPackageFilterWithShapePolicy({
    generatedDeploymentPackage,
    deploymentCompatibilityPlan,
    autoExcludeShapeFormulaConflicts = false,
    resolvedDependencies = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    dependencyExplorer = null
} = {}) {
    const policyEnabled = autoExcludeShapeFormulaConflicts === true;
    const baseWarnings = Array.isArray(
        deploymentCompatibilityPlan?.compatibilityWarnings
    )
        ? deploymentCompatibilityPlan.compatibilityWarnings
        : [];

    const planForFilter = {
        ...deploymentCompatibilityPlan,
        compatibilityWarnings: augmentCompatibilityWarningsForShapePolicy(
            baseWarnings,
            policyEnabled
        )
    };

    const packageComponentCountBeforeFilter = countUniquePackageMembers(
        generatedDeploymentPackage
    );

    const initialFilter = deploymentCompatibilityFilterService.filter({
        generatedDeploymentPackage,
        deploymentCompatibilityPlan: planForFilter
    });

    const shapeExcluded = (initialFilter.excludedComponents || []).filter(
        (item) =>
            item?.exclusionPolicy === 'SHAPE_DESTINATION_FORMULA' ||
            (policyEnabled &&
                baseWarnings.some(
                    (warning) =>
                        isEligibleShapeFormulaAutoExcludeWarning(warning) &&
                        warning.metadataName === item.metadataName
                ))
    );

    let filterResult = initialFilter;
    let shapeFormulaExclusionPolicy = {
        enabled: policyEnabled,
        applied: false,
        revertedDueToBlockingDependencies: false,
        suppressedExclusions: [],
        blockedDependents: [],
        residualDiscoveryRiskNote: RESIDUAL_DISCOVERY_RISK_NOTE
    };

    if (policyEnabled && shapeExcluded.length > 0) {
        const impact =
            deploymentCompatibilityImpactService.analyze({
                filteredDeploymentPackage: initialFilter.deploymentPackage,
                excludedComponents: initialFilter.excludedComponents,
                resolvedDependencies,
                discoveredRelationships,
                discoveredReferences,
                dependencyExplorer
            });

        if ((impact.blockingComponents || []).length > 0) {
            const legacyFilter = deploymentCompatibilityFilterService.filter({
                generatedDeploymentPackage,
                deploymentCompatibilityPlan
            });

            filterResult = legacyFilter;
            shapeFormulaExclusionPolicy = {
                ...shapeFormulaExclusionPolicy,
                applied: false,
                revertedDueToBlockingDependencies: true,
                suppressedExclusions: shapeExcluded.map((item) => ({
                    metadataType: item.metadataType,
                    metadataName: item.metadataName,
                    reason: item.reason,
                    category: item.category
                })),
                blockedDependents: impact.blockingComponents
            };
        } else {
            filterResult = {
                ...initialFilter,
                excludedComponents: annotateShapeExclusions(
                    initialFilter.excludedComponents
                )
            };
            shapeFormulaExclusionPolicy = {
                ...shapeFormulaExclusionPolicy,
                applied: true
            };
        }
    } else if (policyEnabled) {
        shapeFormulaExclusionPolicy.applied = false;
    }

    const packageComponentCountAfterFilter = countUniquePackageMembers(
        filterResult.deploymentPackage
    );

    return {
        deploymentPackage: filterResult.deploymentPackage,
        excludedComponents: filterResult.excludedComponents || [],
        compatibilitySummary: filterResult.compatibilitySummary || {
            totalExcluded: 0,
            totalRemaining: packageComponentCountAfterFilter,
            excludedByCategory: {}
        },
        packageComponentCountBeforeFilter,
        packageComponentCountAfterFilter,
        shapeFormulaExclusionPolicy
    };
}

function resolveCheckOnlyReporting(checkOnlyDeployment, compatibilityDeploymentSkipped) {
    if (compatibilityDeploymentSkipped) {
        return {
            checkOnlyExecuted: false,
            checkOnlySuccess: null,
            checkOnlyExecutionState: 'NOT_EXECUTED'
        };
    }

    if (!checkOnlyDeployment || typeof checkOnlyDeployment !== 'object') {
        return {
            checkOnlyExecuted: false,
            checkOnlySuccess: null,
            checkOnlyExecutionState: 'UNKNOWN'
        };
    }

    if (
        checkOnlyDeployment.executed === false ||
        String(checkOnlyDeployment.status || '').toUpperCase() === 'NOT_EXECUTED'
    ) {
        return {
            checkOnlyExecuted: false,
            checkOnlySuccess: null,
            checkOnlyExecutionState: 'NOT_EXECUTED'
        };
    }

    return {
        checkOnlyExecuted: true,
        checkOnlySuccess: checkOnlyDeployment.success === true,
        checkOnlyExecutionState:
            checkOnlyDeployment.success === true ? 'SUCCESS' : 'FAILURE'
    };
}

function buildDeploymentValidationScope({
    deploymentPackage,
    packageComponentCountBeforeFilter,
    packageComponentCountAfterFilter,
    excludedComponents,
    blockingComponents,
    compatibilityWarnings = [],
    finalDeploymentPackage = null,
    autoExcludeShapeFormulaConflicts,
    shapeFormulaExclusionPolicy,
    checkOnlyDeployment,
    compatibilityDeploymentSkipped
} = {}) {
    const excluded = Array.isArray(excludedComponents)
        ? excludedComponents
        : [];
    const blocking = Array.isArray(blockingComponents)
        ? blockingComponents
        : [];
    const policyState = shapeFormulaExclusionPolicy || {
        enabled: false,
        applied: false,
        revertedDueToBlockingDependencies: false,
        suppressedExclusions: [],
        blockedDependents: [],
        residualDiscoveryRiskNote: RESIDUAL_DISCOVERY_RISK_NOTE
    };
    const suppressedShapeExclusions = Array.isArray(
        policyState.suppressedExclusions
    )
        ? policyState.suppressedExclusions
        : [];
    const checkOnly = resolveCheckOnlyReporting(
        checkOnlyDeployment,
        compatibilityDeploymentSkipped
    );
    const shapeExcludedCount = excluded.filter((item) =>
        isShapePolicyExclusion(item)
    ).length;
    const unresolvedShapeFormulaConflicts = collectUnresolvedShapeFormulaConflicts(
        compatibilityWarnings,
        finalDeploymentPackage || deploymentPackage
    );
    const hasUnresolvedShapeFormulaConflicts =
        unresolvedShapeFormulaConflicts.length > 0;
    const selectedCount = countSelectedComponents(deploymentPackage);

    const validatesReducedPackageOnly =
        excluded.length > 0 &&
        checkOnly.checkOnlyExecuted === true &&
        packageComponentCountAfterFilter < packageComponentCountBeforeFilter;

    const validatesAllSelectedComponents =
        excluded.length === 0 &&
        !hasUnresolvedShapeFormulaConflicts &&
        checkOnly.checkOnlyExecuted === true;

    const allSelectedComponentsValidated =
        checkOnly.checkOnlyExecuted === true &&
        checkOnly.checkOnlySuccess === true &&
        excluded.length === 0 &&
        !hasUnresolvedShapeFormulaConflicts;

    return {
        autoExcludeShapeFormulaConflicts:
            autoExcludeShapeFormulaConflicts === true,
        selectedComponentCount: selectedCount,
        selectedComponentCountAvailable: selectedCount != null,
        selectedComponentCountSemantics:
            'Count of deduplicated deploymentPackage.selectedMetadata entries; null when selectedMetadata is not an array.',
        packageComponentCountBeforeFilter,
        packageComponentCountAfterFilter,
        packageComponentCountSemantics:
            'Unique package members (metadata ∪ dependencies) using readiness itemKey deduplication.',
        excludedComponentCount: excluded.length,
        shapeExcludedComponentCount: shapeExcludedCount,
        suppressedShapeExclusionCount: suppressedShapeExclusions.length,
        blockingComponentCount: blocking.length,
        unresolvedShapeFormulaConflictCount:
            unresolvedShapeFormulaConflicts.length,
        hasUnresolvedShapeFormulaConflicts,
        unresolvedShapeFormulaConflicts,
        ...checkOnly,
        validatesReducedPackageOnly,
        validatesReducedPackageSemantics:
            'Check-only executed against a smaller unique package member set after final exclusions.',
        validatesAllSelectedComponents,
        validatesAllSelectedComponentsSemantics:
            'True only when check-only ran, no final exclusions, and no unresolved shape-index formula conflicts remain in the final package.',
        allSelectedComponentsValidated,
        allSelectedComponentsValidatedSemantics:
            'True only when check-only succeeded and every selected component was in scope without final exclusions or unresolved shape formula conflicts.',
        shapeFormulaExclusionPolicy: policyState,
        residualDiscoveryRiskNote: RESIDUAL_DISCOVERY_RISK_NOTE
    };
}

module.exports = {
    RESIDUAL_DISCOVERY_RISK_NOTE,
    SHAPE_DETECTION_SOURCE,
    EXCLUSION_SOURCE_SHAPE_POLICY,
    resolveAutoExcludeShapeFormulaConflictsPolicy,
    parseAutoExcludeShapeFormulaConflictsPolicy,
    isEligibleShapeFormulaAutoExcludeWarning,
    augmentCompatibilityWarningsForShapePolicy,
    applyCompatibilityPackageFilterWithShapePolicy,
    buildDeploymentValidationScope,
    isShapePolicyExclusion,
    countUniquePackageMembers,
    collectUnresolvedShapeFormulaConflicts
};
