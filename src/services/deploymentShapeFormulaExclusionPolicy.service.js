/**
 * Phase 2 — Opt-in auto-exclusion for shape-confirmed destination-formula conflicts.
 *
 * Uses existing compatibility filter + dependency-impact analysis.
 * Reverts shape exclusions when impact reports blocking dependents.
 */

'use strict';

const deploymentCompatibilityFilterService = require('./deploymentCompatibilityFilter.service');
const deploymentCompatibilityImpactService = require('./deploymentCompatibilityImpact.service');

const RESIDUAL_DISCOVERY_RISK_NOTE =
    'Dependency-impact analysis only considers relationships captured in the deployment discovery graph. ' +
    'An empty blocker list does not prove that excluding a field is safe; metadata may still reference excluded fields without a recorded edge.';

const SHAPE_DETECTION_SOURCE = 'SHAPE_INDEX';
const EXCLUSION_SOURCE_SHAPE_POLICY = 'SHAPE_FORMULA_POLICY';

function parseAutoExcludeShapeFormulaConflictsPolicy(deploymentPackage) {
    return deploymentPackage?.autoExcludeShapeFormulaConflicts === true;
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

function countPackageMembers(deploymentPackage) {
    const metadata = Array.isArray(deploymentPackage?.metadata)
        ? deploymentPackage.metadata.length
        : 0;
    const dependencies = Array.isArray(deploymentPackage?.dependencies)
        ? deploymentPackage.dependencies.length
        : 0;

    return metadata + dependencies;
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

    const packageComponentCountBeforeFilter = countPackageMembers(
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

    const packageComponentCountAfterFilter = countPackageMembers(
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
    const checkOnly = resolveCheckOnlyReporting(
        checkOnlyDeployment,
        compatibilityDeploymentSkipped
    );
    const shapeExcludedCount = excluded.filter((item) =>
        isShapePolicyExclusion(item)
    ).length;

    const validatesReducedPackageOnly =
        excluded.length > 0 &&
        checkOnly.checkOnlyExecuted === true &&
        packageComponentCountAfterFilter < packageComponentCountBeforeFilter;

    const validatesAllSelectedComponents =
        excluded.length === 0 && checkOnly.checkOnlyExecuted === true;

    return {
        autoExcludeShapeFormulaConflicts:
            autoExcludeShapeFormulaConflicts === true,
        selectedComponentCount: countSelectedComponents(deploymentPackage),
        packageComponentCountBeforeFilter,
        packageComponentCountAfterFilter,
        excludedComponentCount: excluded.length,
        shapeExcludedComponentCount: shapeExcludedCount,
        blockingComponentCount: blocking.length,
        ...checkOnly,
        validatesReducedPackageOnly,
        validatesAllSelectedComponents:
            validatesAllSelectedComponents && !validatesReducedPackageOnly,
        allSelectedComponentsValidated:
            checkOnly.checkOnlyExecuted === true &&
            excluded.length === 0 &&
            checkOnly.checkOnlySuccess === true,
        shapeFormulaExclusionPolicy:
            shapeFormulaExclusionPolicy || {
                enabled: false,
                applied: false,
                revertedDueToBlockingDependencies: false,
                suppressedExclusions: [],
                blockedDependents: [],
                residualDiscoveryRiskNote: RESIDUAL_DISCOVERY_RISK_NOTE
            },
        residualDiscoveryRiskNote: RESIDUAL_DISCOVERY_RISK_NOTE
    };
}

module.exports = {
    RESIDUAL_DISCOVERY_RISK_NOTE,
    SHAPE_DETECTION_SOURCE,
    EXCLUSION_SOURCE_SHAPE_POLICY,
    parseAutoExcludeShapeFormulaConflictsPolicy,
    isEligibleShapeFormulaAutoExcludeWarning,
    augmentCompatibilityWarningsForShapePolicy,
    applyCompatibilityPackageFilterWithShapePolicy,
    buildDeploymentValidationScope,
    isShapePolicyExclusion,
    countPackageMembers
};
