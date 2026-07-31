const sessionPricePackageDebug = require('./sessionPricePackageDebug.temp');

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

    const result = [...metadataMap.values()];

    // TEMPORARY DEBUG — Session__c.Price__c package tracing.
    sessionPricePackageDebug.logPackageStage({
        stageName: 'normalizeMetadata return',
        collectionName: 'selectedMetadata (normalized)',
        collection: result,
        method: 'normalizeMetadata',
        caller:
            'composeMetadataWithRequiredDependencies / generateDeploymentPackage'
    });

    return result;
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

    // TEMPORARY DEBUG — detect Price already in input before Map normalize.
    sessionPricePackageDebug.logFoundBeforePackageBuild({
        collectionName: 'requiredDependencies (normalizeDependencies input)',
        method: 'normalizeDependencies',
        collection: requiredDependencies
    });

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

        // TEMPORARY DEBUG — Map insert of Session__c.Price__c.
        sessionPricePackageDebug.logSessionPriceInserted({
            method: 'normalizeDependencies',
            caller:
                'generateDeploymentPackage / composeMetadataWithRequiredDependencies',
            collectionReceiving: 'dependencyMap',
            collectionSource: 'requiredDependencies',
            metadataObject: normalized
        });

        dependencyMap.set(key, normalized);
    }

    const result = [...dependencyMap.values()].sort((a, b) => {
        const typeCompare = a.type.localeCompare(b.type);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.name.localeCompare(b.name);
    });

    // TEMPORARY DEBUG — Map -> Array result.
    sessionPricePackageDebug.logPackageStage({
        stageName: 'normalizeDependencies return (Map -> Array)',
        collectionName: 'normalizedDependencies',
        collection: result,
        method: 'normalizeDependencies',
        caller:
            'generateDeploymentPackage / composeMetadataWithRequiredDependencies'
    });

    return result;
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

    // TEMPORARY DEBUG — conversion into package metadata shape.
    sessionPricePackageDebug.logSessionPriceInserted({
        method: 'dependencyToMetadataItem',
        caller: 'composeMetadataWithRequiredDependencies',
        collectionReceiving: 'metadataItem (return)',
        collectionSource: 'autoIncludeDependencies',
        metadataObject: {
            type: dependency.type,
            name: dependency.name,
            ...item
        }
    });

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

    // TEMPORARY DEBUG — after filter(shouldAutoIncludeDependency).
    sessionPricePackageDebug.logPackageStage({
        stageName: 'composeMetadata autoIncludeDependencies after filter',
        collectionName: 'autoIncludeDependencies',
        collection: autoIncludeDependencies,
        method: 'composeMetadataWithRequiredDependencies',
        caller: 'generateDeploymentPackage'
    });

    for (const dependency of autoIncludeDependencies) {
        const metadataItem = dependencyToMetadataItem(dependency);
        const key = getMetadataUniquenessKey(metadataItem);

        if (!key || metadataMap.has(key)) {
            continue;
        }

        // TEMPORARY DEBUG — push into composed package metadata.
        sessionPricePackageDebug.logSessionPriceInserted({
            method: 'composeMetadataWithRequiredDependencies',
            caller: 'generateDeploymentPackage',
            collectionReceiving: 'composed',
            collectionSource: 'autoIncludeDependencies',
            metadataObject: {
                type: metadataItem.metadataType,
                name: metadataItem.metadataName,
                ...metadataItem
            }
        });

        metadataMap.set(key, metadataItem);
        composed.push(metadataItem);
    }

    sessionPricePackageDebug.logPackageStage({
        stageName: 'composeMetadataWithRequiredDependencies return',
        collectionName: 'composed metadata',
        collection: composed,
        method: 'composeMetadataWithRequiredDependencies',
        caller: 'generateDeploymentPackage'
    });

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

    // TEMPORARY DEBUG — package assembly input.
    sessionPricePackageDebug.logFoundBeforePackageBuild({
        collectionName: 'deploymentPackage.requiredDependencies',
        method: 'generateDeploymentPackage',
        collection: deploymentPackage.requiredDependencies
    });
    sessionPricePackageDebug.logFoundBeforePackageBuild({
        collectionName: 'deploymentPackage.selectedMetadata',
        method: 'generateDeploymentPackage',
        collection: deploymentPackage.selectedMetadata
    });
    sessionPricePackageDebug.logPackageStage({
        stageName: 'generateDeploymentPackage INPUT requiredDependencies',
        collectionName: 'deploymentPackage.requiredDependencies',
        collection: deploymentPackage.requiredDependencies,
        method: 'generateDeploymentPackage',
        caller: 'deploymentValidation.validateDeployment'
    });

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

    const result = {
        metadata,
        dependencies,
        testClasses,
        summary: buildSummary(metadata, dependencies, testClasses)
    };

    sessionPricePackageDebug.logPackageStage({
        stageName: 'generateDeploymentPackage OUTPUT metadata',
        collectionName: 'result.metadata',
        collection: result.metadata,
        method: 'generateDeploymentPackage',
        caller: 'deploymentValidation.validateDeployment'
    });
    sessionPricePackageDebug.logPackageStage({
        stageName: 'generateDeploymentPackage OUTPUT dependencies',
        collectionName: 'result.dependencies',
        collection: result.dependencies,
        method: 'generateDeploymentPackage',
        caller: 'deploymentValidation.validateDeployment'
    });

    return result;
}

module.exports = {
    generateDeploymentPackage
};
