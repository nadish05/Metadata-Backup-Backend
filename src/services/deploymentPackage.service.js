function normalizeMetadataItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const metadataType = item.metadataType || null;
    const metadataName = item.metadataName || null;
    const filePath = item.filePath || null;

    if (!metadataType && !metadataName && !filePath) {
        return null;
    }

    const apiVersion =
        item.apiVersion || item.apiValidation?.apiVersion || null;

    const normalized = {
        metadataType,
        metadataName,
        filePath,
        sourceExists: item.sourceExists,
        artifactResolved: item.artifactResolved
    };

    // Preserve embedded API version for deployment API version policy.
    // Does not change package membership / selection.
    if (apiVersion) {
        normalized.apiVersion = String(apiVersion);
    }

    return normalized;
}

function getMetadataUniquenessKey(item) {
    if (item.metadataType && item.metadataName) {
        return `${item.metadataType}:${item.metadataName}`;
    }

    if (item.filePath) {
        return `filePath:${item.filePath}`;
    }

    return null;
}

function normalizeMetadata(selectedMetadata) {
    if (!Array.isArray(selectedMetadata)) {
        return [];
    }

    const metadataMap = new Map();

    for (const item of selectedMetadata) {
        const normalized = normalizeMetadataItem(item);

        if (!normalized) {
            continue;
        }

        const key = getMetadataUniquenessKey(normalized);

        if (!key || metadataMap.has(key)) {
            continue;
        }

        metadataMap.set(key, normalized);
    }

    return [...metadataMap.values()];
}

function normalizeDependencyItem(item) {
    if (!item?.name || !item?.type) {
        return null;
    }

    const normalized = {
        name: item.name,
        type: item.type,
        required: item.required !== false,
        selected: item.selected !== false
    };

    // Preserve resolved actions from Dependency Resolution Engine when present.
    if (item.action) {
        normalized.action = item.action;
    }

    if (item.destinationState) {
        normalized.destinationState = item.destinationState;
    }

    if (item.relationship) {
        normalized.relationship = item.relationship;
    }

    if (item.reason) {
        normalized.reason = item.reason;
    }

    if (item.source) {
        normalized.source = item.source;
    }

    if (typeof item.editable === 'boolean') {
        normalized.editable = item.editable;
    }

    if (item.filePath) {
        normalized.filePath = item.filePath;
    }

    if (typeof item.sourceExists === 'boolean') {
        normalized.sourceExists = item.sourceExists;
    }

    if (typeof item.artifactResolved === 'boolean') {
        normalized.artifactResolved = item.artifactResolved;
    }

    const apiVersion =
        item.apiVersion || item.apiValidation?.apiVersion || null;

    if (apiVersion) {
        normalized.apiVersion = String(apiVersion);
    }

    return normalized;
}

function getDependencyUniquenessKey(item) {
    return `${item.type}:${item.name}`;
}

function normalizeDependencies(requiredDependencies) {
    if (!Array.isArray(requiredDependencies)) {
        return [];
    }

    const dependencyMap = new Map();

    for (const item of requiredDependencies) {
        const normalized = normalizeDependencyItem(item);

        if (!normalized) {
            continue;
        }

        const key = getDependencyUniquenessKey(normalized);

        if (dependencyMap.has(key)) {
            continue;
        }

        dependencyMap.set(key, normalized);
    }

    return [...dependencyMap.values()].sort((a, b) => {
        const typeCompare = a.type.localeCompare(b.type);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.name.localeCompare(b.name);
    });
}

function shouldAutoIncludeDependency(dependency) {
    // Action-aware path: only DEPLOY decisions are auto-included.
    // REFERENCE / SKIP / BLOCK / MERGE are never included.
    // Dependencies without an action keep the legacy required && selected rule.
    //
    // Deployment Planner overrides are applied upstream to the decision model
    // (selected only). This gate must not read deploymentSelections directly.
    if (dependency.action) {
        return (
            dependency.action === 'DEPLOY' && dependency.selected === true
        );
    }

    return dependency.required === true && dependency.selected === true;
}

function dependencyToMetadataItem(dependency) {
    const item = {
        metadataType: dependency.type,
        metadataName: dependency.name,
        filePath: dependency.filePath || null,
        sourceExists: dependency.sourceExists,
        artifactResolved: dependency.artifactResolved
    };

    const apiVersion =
        dependency.apiVersion ||
        dependency.apiValidation?.apiVersion ||
        null;

    if (apiVersion) {
        item.apiVersion = String(apiVersion);
    }

    return item;
}

function composeMetadataWithRequiredDependencies(
    selectedMetadata,
    requiredDependencies
) {
    const selected = normalizeMetadata(selectedMetadata);
    const metadataMap = new Map();
    const composed = [];

    for (const item of selected) {
        const key = getMetadataUniquenessKey(item);

        if (!key || metadataMap.has(key)) {
            continue;
        }

        metadataMap.set(key, item);
        composed.push(item);
    }

    const autoIncludeDependencies = normalizeDependencies(requiredDependencies)
        .filter(shouldAutoIncludeDependency)
        .sort((a, b) => {
            const typeCompare = a.type.localeCompare(b.type);

            if (typeCompare !== 0) {
                return typeCompare;
            }

            return a.name.localeCompare(b.name);
        });

    for (const dependency of autoIncludeDependencies) {
        const metadataItem = dependencyToMetadataItem(dependency);
        const key = getMetadataUniquenessKey(metadataItem);

        if (!key || metadataMap.has(key)) {
            continue;
        }

        metadataMap.set(key, metadataItem);
        composed.push(metadataItem);
    }

    return composed;
}

function resolveTestClassName(testClass) {
    if (typeof testClass === 'string') {
        return testClass;
    }

    return testClass?.name || null;
}

function normalizeTestClasses(selectedTestClasses) {
    if (!Array.isArray(selectedTestClasses)) {
        return [];
    }

    const testClassNames = new Set();

    for (const testClass of selectedTestClasses) {
        const name = resolveTestClassName(testClass);

        if (name) {
            testClassNames.add(name);
        }
    }

    return [...testClassNames]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name }));
}

function buildSummary(metadata, dependencies, testClasses) {
    const metadataCount = metadata.length;
    const dependencyCount = dependencies.length;
    const testClassCount = testClasses.length;

    return {
        metadataCount,
        dependencyCount,
        testClassCount,
        totalComponents: metadataCount + dependencyCount
    };
}

function generateDeploymentPackage(deploymentPackage) {
    if (!deploymentPackage || typeof deploymentPackage !== 'object') {
        return {
            metadata: [],
            dependencies: [],
            testClasses: [],
            summary: buildSummary([], [], [])
        };
    }

    const metadata = composeMetadataWithRequiredDependencies(
        deploymentPackage.selectedMetadata,
        deploymentPackage.requiredDependencies
    );
    const dependencies = normalizeDependencies(
        deploymentPackage.requiredDependencies
    ).filter(shouldAutoIncludeDependency);
    const testClasses = normalizeTestClasses(
        deploymentPackage.selectedTestClasses
    );

    const generatedDeploymentPackage = {
        metadata,
        dependencies,
        testClasses,
        summary: buildSummary(metadata, dependencies, testClasses)
    };

    // TEMPORARY DEBUG — Phase 10.13 Part 10 (inside generateDeploymentPackage)
    try {
        const { logBookingTrace } = require('./bookingTrace.temp');
        logBookingTrace({
            stage: 'PART 10 — inside generateDeploymentPackage()',
            collection: 'generatedDeploymentPackage.dependencies',
            items: generatedDeploymentPackage.dependencies,
            caller: 'generateDeploymentPackage',
            method: 'generateDeploymentPackage'
        });
        logBookingTrace({
            stage: 'PART 10 — inside generateDeploymentPackage()',
            collection: 'generatedDeploymentPackage.metadata',
            items: generatedDeploymentPackage.metadata,
            caller: 'generateDeploymentPackage',
            method: 'generateDeploymentPackage'
        });
    } catch (error) {
        // Debug-only; never affect package generation.
    }

    // TEMPORARY DEBUG — Phase 10.17 PART 10 (inside generateDeploymentPackage)
    try {
        const {
            logCustomFieldLifecycleTrace
        } = require('./customFieldLifecycleTrace.temp');
        logCustomFieldLifecycleTrace({
            stage: 'PART 10 — inside generateDeploymentPackage()',
            collection: 'generatedDeploymentPackage.dependencies',
            items: generatedDeploymentPackage.dependencies,
            caller: 'generateDeploymentPackage',
            method: 'generateDeploymentPackage'
        });
        logCustomFieldLifecycleTrace({
            stage: 'PART 10 — inside generateDeploymentPackage()',
            collection: 'generatedDeploymentPackage.metadata',
            items: generatedDeploymentPackage.metadata,
            caller: 'generateDeploymentPackage',
            method: 'generateDeploymentPackage'
        });
    } catch (error) {
        // Debug-only; never affect package generation.
    }

    return generatedDeploymentPackage;
}

module.exports = {
    generateDeploymentPackage
};
