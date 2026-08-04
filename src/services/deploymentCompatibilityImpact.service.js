/**
 * Compatibility Dependency Impact Analysis (Phase 11.2).
 *
 * REPORT-ONLY: identifies remaining package members that depend on
 * auto-excluded components. Does not modify package, workspace, CLI,
 * planner, or deployment behavior.
 */

const { buildGraphNodeId, parseGraphNodeId } = require('./dependencyResolution/graphId');

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function itemKey(type, name) {
    return buildGraphNodeId(type, name);
}

function collectPackageMembers(filteredDeploymentPackage) {
    const members = new Map();
    const items = [
        ...(filteredDeploymentPackage?.metadata || []),
        ...(filteredDeploymentPackage?.dependencies || [])
    ];

    for (const item of items) {
        const type = getItemType(item);
        const name = getItemName(item);
        const key = itemKey(type, name);

        if (!key) {
            continue;
        }

        members.set(key, { metadataType: type, metadataName: name });
    }

    return members;
}

function buildExcludedMap(excludedComponents) {
    const excluded = new Map();

    for (const component of excludedComponents || []) {
        const type = component?.metadataType || null;
        const name = component?.metadataName || null;
        const key = itemKey(type, name);

        if (!key) {
            continue;
        }

        excluded.set(key, {
            metadataType: type,
            metadataName: name,
            reason: component.reason || 'Component was auto-excluded.',
            category: component.category || null
        });
    }

    return excluded;
}

/**
 * Record that consumer depends on dependency.
 * Map: consumerKey → Set of dependency keys
 */
function addDependencyEdge(edgeMap, consumerType, consumerName, depType, depName) {
    const consumerKey = itemKey(consumerType, consumerName);
    const depKey = itemKey(depType, depName);

    if (!consumerKey || !depKey || consumerKey === depKey) {
        return;
    }

    if (!edgeMap.has(consumerKey)) {
        edgeMap.set(consumerKey, new Set());
    }

    edgeMap.get(consumerKey).add(depKey);
}

function inferSourceType(sourceName, packageMembers) {
    if (!sourceName) {
        return null;
    }

    if (String(sourceName).includes('.')) {
        return 'CustomField';
    }

    // Prefer an exact package match when available.
    for (const [key, member] of packageMembers.entries()) {
        if (member.metadataName === sourceName) {
            return member.metadataType;
        }
    }

    if (/__c$/i.test(String(sourceName))) {
        return 'CustomObject';
    }

    return null;
}

function collectDependencyEdges({
    packageMembers,
    resolvedDependencies,
    discoveredRelationships,
    discoveredReferences,
    dependencyExplorer
}) {
    const edgeMap = new Map();

    for (const relationship of discoveredRelationships || []) {
        const depType = relationship.metadataType || relationship.type;
        const depName = relationship.name;
        const sourceName = relationship.sourceMetadata;
        const sourceField = relationship.sourceField;
        let sourceType = inferSourceType(sourceName, packageMembers);

        if (!sourceType && sourceName) {
            // Field-level discovery often stores object API name as sourceMetadata.
            sourceType = 'CustomObject';
        }

        if (sourceName && sourceField && !String(sourceName).includes('.')) {
            const fieldConsumer = `${sourceName}.${sourceField}`;
            addDependencyEdge(
                edgeMap,
                'CustomField',
                fieldConsumer,
                depType,
                depName
            );
        }

        addDependencyEdge(edgeMap, sourceType, sourceName, depType, depName);
    }

    for (const reference of discoveredReferences || []) {
        const depType = reference.metadataType || reference.type;
        const depName = reference.name;
        const sourceName = reference.sourceMetadata;
        let sourceType =
            reference.sourceMetadataType ||
            inferSourceType(sourceName, packageMembers);

        if (!sourceType && sourceName) {
            // Reference discoverers commonly originate from FlexiPage / Flow / LWC.
            if (packageMembers.has(itemKey('Flow', sourceName))) {
                sourceType = 'Flow';
            } else if (packageMembers.has(itemKey('FlexiPage', sourceName))) {
                sourceType = 'FlexiPage';
            } else if (
                packageMembers.has(
                    itemKey('LightningComponentBundle', sourceName)
                )
            ) {
                sourceType = 'LightningComponentBundle';
            } else {
                sourceType = 'FlexiPage';
            }
        }

        addDependencyEdge(edgeMap, sourceType, sourceName, depType, depName);
    }

    for (const dependency of resolvedDependencies || []) {
        const depType = dependency.metadataType || dependency.type;
        const depName = dependency.name || dependency.metadataName;
        const sourceName = dependency.sourceMetadata;

        if (sourceName) {
            const sourceType =
                dependency.sourceMetadataType ||
                inferSourceType(sourceName, packageMembers) ||
                'CustomObject';
            addDependencyEdge(edgeMap, sourceType, sourceName, depType, depName);

            if (
                dependency.sourceField &&
                !String(sourceName).includes('.')
            ) {
                addDependencyEdge(
                    edgeMap,
                    'CustomField',
                    `${sourceName}.${dependency.sourceField}`,
                    depType,
                    depName
                );
            }
        }

        const requiredBy = Array.isArray(dependency.requiredBy)
            ? dependency.requiredBy
            : [];

        for (const parent of requiredBy) {
            if (typeof parent === 'string') {
                const parsed = parseGraphNodeId(parent);

                if (parsed) {
                    addDependencyEdge(
                        edgeMap,
                        parsed.metadataType,
                        parsed.name,
                        depType,
                        depName
                    );
                } else {
                    const sourceType =
                        inferSourceType(parent, packageMembers) ||
                        'CustomObject';
                    addDependencyEdge(
                        edgeMap,
                        sourceType,
                        parent,
                        depType,
                        depName
                    );
                }
            } else if (parent && typeof parent === 'object') {
                addDependencyEdge(
                    edgeMap,
                    parent.metadataType || parent.type,
                    parent.metadataName || parent.name,
                    depType,
                    depName
                );
            }
        }
    }

    const explorerEdges = dependencyExplorer?.edges;

    if (Array.isArray(explorerEdges)) {
        for (const edge of explorerEdges) {
            const from = parseGraphNodeId(edge.from || edge.fromId);
            const to = parseGraphNodeId(edge.to || edge.toId);

            if (!from || !to) {
                continue;
            }

            // Explorer edges are parent → child (parent depends on child).
            addDependencyEdge(
                edgeMap,
                from.metadataType,
                from.name,
                to.metadataType,
                to.name
            );
        }
    }

    return edgeMap;
}

function buildBlockingSummary(blockingComponents) {
    const blockingByMetadataType = {};
    const blockingByCategory = {};

    for (const component of blockingComponents) {
        const type = component.metadataType || 'Unknown';
        blockingByMetadataType[type] = (blockingByMetadataType[type] || 0) + 1;

        for (const blocker of component.blockedBy || []) {
            const category = blocker.category || 'UNKNOWN';
            blockingByCategory[category] =
                (blockingByCategory[category] || 0) + 1;
        }
    }

    return {
        totalBlocking: blockingComponents.length,
        blockingByMetadataType,
        blockingByCategory
    };
}

/**
 * Analyze remaining package members for dependencies on excluded components.
 *
 * @returns {{ blockingComponents: object[], blockingSummary: object }}
 */
function analyze({
    filteredDeploymentPackage,
    excludedComponents = [],
    resolvedDependencies = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    dependencyExplorer = null
} = {}) {
    const packageMembers = collectPackageMembers(filteredDeploymentPackage);
    const excludedMap = buildExcludedMap(excludedComponents);

    if (!packageMembers.size || !excludedMap.size) {
        return {
            blockingComponents: [],
            blockingSummary: {
                totalBlocking: 0,
                blockingByMetadataType: {},
                blockingByCategory: {}
            }
        };
    }

    const edgeMap = collectDependencyEdges({
        packageMembers,
        resolvedDependencies,
        discoveredRelationships,
        discoveredReferences,
        dependencyExplorer
    });

    const blockingComponents = [];

    for (const [memberKey, member] of packageMembers.entries()) {
        if (excludedMap.has(memberKey)) {
            continue;
        }

        const dependencyKeys = edgeMap.get(memberKey);

        if (!dependencyKeys || !dependencyKeys.size) {
            continue;
        }

        const blockedBy = [];
        const seen = new Set();

        for (const depKey of dependencyKeys) {
            if (!excludedMap.has(depKey) || seen.has(depKey)) {
                continue;
            }

            seen.add(depKey);
            blockedBy.push({ ...excludedMap.get(depKey) });
        }

        if (!blockedBy.length) {
            continue;
        }

        blockingComponents.push({
            metadataType: member.metadataType,
            metadataName: member.metadataName,
            blockedBy,
            action: 'BLOCKING'
        });
    }

    blockingComponents.sort((a, b) => {
        const typeCompare = String(a.metadataType).localeCompare(
            String(b.metadataType)
        );

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return String(a.metadataName).localeCompare(String(b.metadataName));
    });

    return {
        blockingComponents,
        blockingSummary: buildBlockingSummary(blockingComponents)
    };
}

module.exports = {
    analyze
};
