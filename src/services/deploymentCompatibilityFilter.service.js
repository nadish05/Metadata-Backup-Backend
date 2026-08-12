/**
 * Compatibility Package Filter (Phase 11.1).
 *
 * AUTO-EXCLUDES incompatible metadata from the generated deployment package
 * based on the read-only deployment compatibility plan.
 *
 * Does not modify discovery, planner, resolution, workspace logic,
 * manifest generation, or CLI execution — only filters the package object.
 */

const AUTO_EXCLUDE_CATEGORIES = Object.freeze([
    'FORMULA_TYPE_CHANGE',
    'FORMULA_COMPILATION',
    'FIELD_TYPE_CHANGE',
    'PICKLIST_TYPE_CHANGE'
]);

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function itemKey(type, name) {
    if (!type || !name) {
        return null;
    }

    return `${String(type)}:${String(name)}`;
}

function buildSummary(metadata, dependencies, testClasses) {
    const metadataCount = Array.isArray(metadata) ? metadata.length : 0;
    const dependencyCount = Array.isArray(dependencies)
        ? dependencies.length
        : 0;
    const testClassCount = Array.isArray(testClasses) ? testClasses.length : 0;

    return {
        metadataCount,
        dependencyCount,
        testClassCount,
        totalComponents: metadataCount + dependencyCount
    };
}

function collectExclusionTargets(deploymentCompatibilityPlan) {
    const targets = new Map();
    const warnings = Array.isArray(
        deploymentCompatibilityPlan?.compatibilityWarnings
    )
        ? deploymentCompatibilityPlan.compatibilityWarnings
        : [];

    for (const warning of warnings) {
        const category = warning?.category;

        if (!AUTO_EXCLUDE_CATEGORIES.includes(category)) {
            continue;
        }

        const metadataName = warning?.metadataName || null;
        const metadataType = warning?.metadataType || 'CustomField';

        if (!metadataName) {
            continue;
        }

        const key = itemKey(metadataType, metadataName);

        if (!key || targets.has(key)) {
            continue;
        }

        targets.set(key, {
            metadataType,
            metadataName,
            reason: warning?.message || `Excluded due to ${category}.`,
            category,
            action: 'AUTO_EXCLUDED'
        });
    }

    return targets;
}

/**
 * Filter deployment package members classified as incompatible.
 *
 * @param {{ generatedDeploymentPackage: object, deploymentCompatibilityPlan: object }} input
 * @returns {{ deploymentPackage: object, excludedComponents: object[], compatibilitySummary: object }}
 */
function filter({
    generatedDeploymentPackage,
    deploymentCompatibilityPlan
} = {}) {
    const emptyPackage = {
        metadata: [],
        dependencies: [],
        testClasses: [],
        summary: buildSummary([], [], [])
    };

    if (!generatedDeploymentPackage || typeof generatedDeploymentPackage !== 'object') {
        return {
            deploymentPackage: emptyPackage,
            excludedComponents: [],
            compatibilitySummary: {
                totalExcluded: 0,
                totalRemaining: 0,
                excludedByCategory: {}
            }
        };
    }

    const exclusionTargets = collectExclusionTargets(
        deploymentCompatibilityPlan
    );
    const excludedComponents = [];
    const excludedKeys = new Set();
    const excludedByCategory = {};

    const originalMetadata = Array.isArray(generatedDeploymentPackage.metadata)
        ? generatedDeploymentPackage.metadata
        : [];
    const originalDependencies = Array.isArray(
        generatedDeploymentPackage.dependencies
    )
        ? generatedDeploymentPackage.dependencies
        : [];
    const testClasses = Array.isArray(generatedDeploymentPackage.testClasses)
        ? [...generatedDeploymentPackage.testClasses]
        : [];

    function maybeExclude(item) {
        const type = getItemType(item);
        const name = getItemName(item);
        const key = itemKey(type, name);

        if (!key || !exclusionTargets.has(key)) {
            return false;
        }

        // Same member can appear in both metadata and dependencies; exclude
        // once from the package but report a single excludedComponents entry.
        if (!excludedKeys.has(key)) {
            excludedKeys.add(key);
            const exclusion = exclusionTargets.get(key);
            excludedComponents.push({ ...exclusion });
            excludedByCategory[exclusion.category] =
                (excludedByCategory[exclusion.category] || 0) + 1;
        }

        return true;
    }

    const metadata = [];

    for (const item of originalMetadata) {
        if (maybeExclude(item)) {
            continue;
        }

        metadata.push(item);
    }

    const dependencies = [];

    for (const item of originalDependencies) {
        if (maybeExclude(item)) {
            continue;
        }

        dependencies.push(item);
    }

    const deploymentPackage = {
        ...generatedDeploymentPackage,
        metadata,
        dependencies,
        testClasses,
        summary: buildSummary(metadata, dependencies, testClasses)
    };

    return {
        deploymentPackage,
        excludedComponents,
        compatibilitySummary: {
            totalExcluded: excludedComponents.length,
            totalRemaining:
                metadata.length + dependencies.length,
            excludedByCategory
        }
    };
}

module.exports = {
    AUTO_EXCLUDE_CATEGORIES,
    filter
};
