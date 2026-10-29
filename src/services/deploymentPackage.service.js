const {
    enrichFlowMetadataItem,
    getFlowMetadataUniquenessKey
} = require('./flowMetadata/flowMemberIdentity.service');
const { normalizeDeployableMetadata } = require('./deployableMetadataNormalizer.service');
const {
    METADATA_ORIGINS,
    resolveMetadataOrigin
} = require('./dependencyResolution/metadataGraphOrigin.model');

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

    let normalized = {
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

    if (metadataType === 'Flow') {
        normalized = enrichFlowMetadataItem({
            ...item,
            ...normalized
        });
    }

    return normalized;
}

function getMetadataUniquenessKey(item) {
    const flowKey = getFlowMetadataUniquenessKey(item);

    if (flowKey) {
        return flowKey;
    }

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

/**
 * Resolve profileOnlyMinimalPackage for validation.
 *
 * 1. If top-level request value is an explicit boolean, it wins.
 * 2. Else if deploymentPackage value is an explicit boolean, use it.
 * 3. Else default false (strings/numbers never enable the policy).
 */
function resolveProfileOnlyMinimalPackagePolicy({
    topLevel = undefined,
    deploymentPackage = null
} = {}) {
    if (typeof topLevel === 'boolean') {
        return topLevel;
    }

    const packageLevel = deploymentPackage?.profileOnlyMinimalPackage;

    if (typeof packageLevel === 'boolean') {
        return packageLevel;
    }

    return false;
}

/**
 * Profile-only minimal package is allowed only when every user-selected row
 * is an unambiguous Profile member (type + name). Does not inspect dependencies.
 */
function evaluateProfileOnlyMinimalPackageEligibility(selectedMetadata) {
    if (!Array.isArray(selectedMetadata) || selectedMetadata.length === 0) {
        return { eligible: false, reason: 'empty_selection' };
    }

    const keys = new Set();

    for (const item of selectedMetadata) {
        if (!item || typeof item !== 'object') {
            return { eligible: false, reason: 'invalid_selection_item' };
        }

        const metadataType = item.metadataType || item.type || null;
        const metadataName = item.metadataName || item.name || null;

        if (metadataType !== 'Profile') {
            return { eligible: false, reason: 'mixed_or_non_profile_selection' };
        }

        if (
            typeof metadataName !== 'string' ||
            !metadataName.trim()
        ) {
            return { eligible: false, reason: 'profile_missing_name' };
        }

        const key = `Profile:${metadataName.trim()}`;

        if (keys.has(key)) {
            return { eligible: false, reason: 'duplicate_profile_selection' };
        }

        keys.add(key);
    }

    return { eligible: true, reason: null };
}

function cloneSelectionItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    return { ...item };
}

/**
 * Resolve the explicit primary user selection used for Profile-only minimal packaging.
 * Does not mutate discovery/resolution inventories.
 *
 * Precedence:
 * 1. deploymentPackage.explicitPrimarySelectedMetadata when provided (client intent).
 * 2. Items marked PRIMARY_SELECTION when the plan also contains other graph origins.
 * 3. Full normalized selectedMetadata snapshot (legacy eligibility semantics).
 */
function resolveExplicitPrimarySelectedMetadata(
    deploymentPackage,
    normalizedSelectedMetadata
) {
    const clientExplicit = deploymentPackage?.explicitPrimarySelectedMetadata;

    if (Array.isArray(clientExplicit) && clientExplicit.length > 0) {
        return normalizeDeployableMetadata(clientExplicit);
    }

    const items = Array.isArray(normalizedSelectedMetadata)
        ? normalizedSelectedMetadata
        : [];

    const hasNonPrimaryOrigin = items.some((item) => {
        const origin = item?.origin;

        return (
            origin &&
            Object.values(METADATA_ORIGINS).includes(origin) &&
            resolveMetadataOrigin(item) !== METADATA_ORIGINS.PRIMARY_SELECTION
        );
    });

    if (hasNonPrimaryOrigin) {
        const primaryItems = items.filter(
            (item) =>
                resolveMetadataOrigin(item) ===
                METADATA_ORIGINS.PRIMARY_SELECTION
        );

        if (primaryItems.length > 0) {
            return primaryItems.map(cloneSelectionItem).filter(Boolean);
        }
    }

    return items.map(cloneSelectionItem).filter(Boolean);
}

function buildExplicitPrimaryProfileKeys(explicitPrimarySelectedMetadata) {
    const keys = new Set();

    for (const item of explicitPrimarySelectedMetadata || []) {
        const metadataType = item.metadataType || item.type || null;
        const metadataName = item.metadataName || item.name || null;

        if (
            metadataType === 'Profile' &&
            typeof metadataName === 'string' &&
            metadataName.trim()
        ) {
            keys.add(`Profile:${metadataName.trim()}`);
        }
    }

    return keys;
}

function buildProfileOnlyMinimalMetadata(
    selectedMetadata,
    explicitPrimarySelectedMetadata
) {
    const allowedKeys = buildExplicitPrimaryProfileKeys(
        explicitPrimarySelectedMetadata
    );

    return normalizeMetadata(selectedMetadata).filter((item) => {
        if (item.metadataType !== 'Profile') {
            return false;
        }

        if (item.selected === false) {
            return false;
        }

        const key = getMetadataUniquenessKey(item);

        return key && allowedKeys.has(key);
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
    requiredDependencies,
    options = {}
) {
    const selected = normalizeMetadata(selectedMetadata);

    if (options.profileOnlyMinimalPackage === true) {
        const explicitPrimary =
            options.explicitPrimarySelectedMetadata ?? selectedMetadata;
        const eligibility =
            evaluateProfileOnlyMinimalPackageEligibility(explicitPrimary);

        if (eligibility.eligible) {
            return buildProfileOnlyMinimalMetadata(
                selectedMetadata,
                explicitPrimary
            );
        }
    }

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

    const profileOnlyMinimalPackage =
        deploymentPackage.profileOnlyMinimalPackage === true;

    const explicitPrimarySelectedMetadata = Array.isArray(
        deploymentPackage.explicitPrimarySelectedMetadata
    )
        ? deploymentPackage.explicitPrimarySelectedMetadata
        : deploymentPackage.selectedMetadata;

    const metadata = composeMetadataWithRequiredDependencies(
        deploymentPackage.selectedMetadata,
        deploymentPackage.requiredDependencies,
        {
            profileOnlyMinimalPackage,
            explicitPrimarySelectedMetadata
        }
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

    return generatedDeploymentPackage;
}

module.exports = {
    generateDeploymentPackage,
    normalizeMetadataItem,
    normalizeMetadata,
    getMetadataUniquenessKey,
    composeMetadataWithRequiredDependencies,
    resolveProfileOnlyMinimalPackagePolicy,
    evaluateProfileOnlyMinimalPackageEligibility,
    resolveExplicitPrimarySelectedMetadata,
    buildProfileOnlyMinimalMetadata
};
