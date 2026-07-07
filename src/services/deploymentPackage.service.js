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

    return {
        metadataType,
        metadataName,
        filePath
    };
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

    return [...metadataMap.values()].sort((a, b) => {
        const typeCompare = String(a.metadataType || '').localeCompare(
            String(b.metadataType || '')
        );

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return String(a.metadataName || '').localeCompare(
            String(b.metadataName || '')
        );
    });
}

function normalizeDependencyItem(item) {
    if (!item?.name || !item?.type) {
        return null;
    }

    return {
        name: item.name,
        type: item.type,
        required: item.required !== false,
        selected: item.selected !== false
    };
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

    const metadata = normalizeMetadata(deploymentPackage.selectedMetadata);
    const dependencies = normalizeDependencies(
        deploymentPackage.requiredDependencies
    );
    const testClasses = normalizeTestClasses(
        deploymentPackage.selectedTestClasses
    );

    return {
        metadata,
        dependencies,
        testClasses,
        summary: buildSummary(metadata, dependencies, testClasses)
    };
}

module.exports = {
    generateDeploymentPackage
};
