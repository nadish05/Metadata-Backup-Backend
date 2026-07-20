const { buildGraphNodeId } = require('./graphId');

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function ensureNode(nodesById, {
    name,
    metadataType,
    depth = 0,
    relationship = null,
    requiredBy = [],
    reason = null,
    discoveredBy = null,
    deployable = null,
    blocking = null,
    referenceType = null,
    sourceElement = null,
    decision = null,
    destinationState = null,
    deploymentAction = null,
    decisionSource = null,
    selected = null,
    required = null
}) {
    const id = buildGraphNodeId(metadataType, name);

    if (!id) {
        return null;
    }

    if (!nodesById.has(id)) {
        nodesById.set(id, {
            id,
            name,
            metadataType,
            depth,
            relationship,
            requiredBy: [],
            reason,
            discoveredBy,
            deployable,
            blocking,
            referenceType,
            sourceElement,
            decision,
            destinationState,
            deploymentAction,
            decisionSource,
            selected,
            required,
            children: []
        });
    }

    const node = nodesById.get(id);

    if (depth != null && (node.depth == null || depth < node.depth)) {
        node.depth = depth;
    }

    if (relationship && !node.relationship) {
        node.relationship = relationship;
    }

    if (reason && !node.reason) {
        node.reason = reason;
    }

    if (discoveredBy && !node.discoveredBy) {
        node.discoveredBy = discoveredBy;
    }

    if (deployable != null && node.deployable == null) {
        node.deployable = deployable;
    }

    if (blocking != null && node.blocking == null) {
        node.blocking = blocking;
    }

    if (referenceType && !node.referenceType) {
        node.referenceType = referenceType;
    }

    if (sourceElement && !node.sourceElement) {
        node.sourceElement = sourceElement;
    }

    if (decision && !node.decision) {
        node.decision = decision;
    }

    if (destinationState && !node.destinationState) {
        node.destinationState = destinationState;
    }

    if (deploymentAction && !node.deploymentAction) {
        node.deploymentAction = deploymentAction;
    }

    if (decisionSource && !node.decisionSource) {
        node.decisionSource = decisionSource;
    }

    if (selected != null && node.selected == null) {
        node.selected = selected;
    }

    if (required != null && node.required == null) {
        node.required = required;
    }

    for (const parentId of requiredBy) {
        if (parentId && !node.requiredBy.includes(parentId)) {
            node.requiredBy.push(parentId);
        }
    }

    return node;
}

function addEdge(edges, fromId, toId, relationship) {
    if (!fromId || !toId) {
        return;
    }

    const key = `${fromId}=>${toId}:${relationship || ''}`;

    if (edges.has(key)) {
        return;
    }

    edges.set(key, {
        from: fromId,
        to: toId,
        relationship: relationship || null
    });
}

function applyDecisions(nodesById, resolvedDependencies) {
    for (const decision of resolvedDependencies || []) {
        const metadataType = decision.metadataType || decision.type;
        const name = decision.name;
        const id = buildGraphNodeId(metadataType, name);

        if (!id) {
            continue;
        }

        ensureNode(nodesById, {
            name,
            metadataType,
            depth: decision.depth || 0,
            relationship: decision.relationship || null,
            reason: decision.reason || null,
            discoveredBy: decision.discoveredBy || null,
            decision: decision.action || null,
            destinationState: decision.destinationState || null,
            deploymentAction: decision.action || null,
            decisionSource: decision.source || null,
            selected: decision.selected,
            required: decision.required
        });

        const node = nodesById.get(id);

        node.decision = decision.action || node.decision;
        node.destinationState =
            decision.destinationState || node.destinationState;
        node.deploymentAction = decision.action || node.deploymentAction;
        node.decisionSource = decision.source || node.decisionSource;
        node.selected =
            decision.selected != null ? decision.selected : node.selected;
        node.required =
            decision.required != null ? decision.required : node.required;
        node.reason = decision.reason || node.reason;
    }
}

function buildRelationshipTree(nodesById, edges) {
    const childrenByParent = new Map();

    for (const edge of edges.values()) {
        if (!childrenByParent.has(edge.from)) {
            childrenByParent.set(edge.from, []);
        }

        childrenByParent.get(edge.from).push({
            id: edge.to,
            relationship: edge.relationship
        });
    }

    function buildNodeTree(nodeId, visited = new Set()) {
        const node = nodesById.get(nodeId);

        if (!node) {
            return null;
        }

        if (visited.has(nodeId)) {
            return {
                id: node.id,
                name: node.name,
                metadataType: node.metadataType,
                circular: true,
                children: []
            };
        }

        const nextVisited = new Set(visited);
        nextVisited.add(nodeId);

        const childLinks = childrenByParent.get(nodeId) || [];

        return {
            id: node.id,
            name: node.name,
            metadataType: node.metadataType,
            relationship: node.relationship,
            depth: node.depth,
            decision: node.decision,
            destinationState: node.destinationState,
            deploymentAction: node.deploymentAction,
            reason: node.reason,
            blocking: node.blocking,
            deployable: node.deployable,
            decisionSource: node.decisionSource,
            requiredBy: [...node.requiredBy],
            children: childLinks
                .map((child) => {
                    const childTree = buildNodeTree(child.id, nextVisited);

                    if (!childTree) {
                        return null;
                    }

                    return {
                        ...childTree,
                        relationship:
                            child.relationship || childTree.relationship
                    };
                })
                .filter(Boolean)
        };
    }

    const rootIds = [...nodesById.values()]
        .filter((node) => !node.requiredBy.length)
        .map((node) => node.id);

    // Fallback: if everything has parents, use lowest depth nodes.
    const roots =
        rootIds.length > 0
            ? rootIds
            : [...nodesById.values()]
                  .sort((a, b) => (a.depth || 0) - (b.depth || 0))
                  .slice(0, 1)
                  .map((node) => node.id);

    return roots.map((rootId) => buildNodeTree(rootId)).filter(Boolean);
}

function buildGraphStatistics(nodes, edges, references) {
    let maxDepth = 0;

    for (const node of nodes) {
        if ((node.depth || 0) > maxDepth) {
            maxDepth = node.depth || 0;
        }
    }

    return {
        totalNodes: nodes.length,
        relationships: edges.length,
        referenceCount: (references || []).length,
        graphDepth: maxDepth,
        blockingReferences: (references || []).filter((item) => item.blocking)
            .length,
        deployableReferences: (references || []).filter(
            (item) => item.deployable
        ).length
    };
}

/**
 * Build a read-only Deployment Dependency Explorer graph for future UI.
 * Does not modify deployment behavior.
 */
function buildDependencyExplorer({
    selectedMetadata = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    resolvedDependencies = [],
    referenceSummary = null
} = {}) {
    logSection('Deployment Dependency Explorer');

    const nodesById = new Map();
    const edges = new Map();
    const warnings = [];

    for (const item of selectedMetadata) {
        if (!item?.metadataType || !(item.metadataName || item.name)) {
            continue;
        }

        const name = item.metadataName || item.name;

        ensureNode(nodesById, {
            name,
            metadataType: item.metadataType,
            depth: 0,
            relationship: 'Selected',
            reason: 'Explicitly selected for deployment.',
            discoveredBy: 'UserSelection',
            deployable: true,
            blocking: false,
            selected: true,
            required: true,
            decisionSource: 'USER'
        });
    }

    for (const relationship of discoveredRelationships) {
        const childType = relationship.metadataType || relationship.type;
        const childName = relationship.name;
        const parentName = relationship.sourceMetadata;
        const parentType = 'CustomObject';

        if (!childType || !childName) {
            continue;
        }

        const parentId = parentName
            ? buildGraphNodeId(parentType, parentName)
            : null;
        const childId = buildGraphNodeId(childType, childName);

        if (parentName) {
            ensureNode(nodesById, {
                name: parentName,
                metadataType: parentType,
                depth: Math.max((relationship.depth || 1) - 1, 0)
            });
        }

        ensureNode(nodesById, {
            name: childName,
            metadataType: childType,
            depth: relationship.depth || 1,
            relationship: relationship.relationship || null,
            requiredBy: parentId ? [parentId] : [],
            reason: relationship.reason || null,
            discoveredBy: relationship.discoveredBy || null,
            deployable: true,
            blocking: relationship.required !== false,
            selected: relationship.selected,
            required: relationship.required
        });

        addEdge(
            edges,
            parentId,
            childId,
            relationship.relationship || relationship.discoveryMethod
        );
    }

    for (const reference of discoveredReferences) {
        const childType = reference.metadataType;
        const childName = reference.name;
        const parentName = reference.sourceMetadata;
        const parentType = 'FlexiPage';

        if (!childType || !childName) {
            continue;
        }

        const parentId = parentName
            ? buildGraphNodeId(parentType, parentName)
            : null;
        const childId = buildGraphNodeId(childType, childName);

        if (parentName) {
            ensureNode(nodesById, {
                name: parentName,
                metadataType: parentType,
                depth: Math.max((reference.depth || 1) - 1, 0)
            });
        }

        ensureNode(nodesById, {
            name: childName,
            metadataType: childType,
            depth: reference.depth || 1,
            relationship: reference.referenceType || reference.relationship,
            requiredBy: parentId ? [parentId] : [],
            reason: reference.reason || null,
            discoveredBy: reference.discoveredBy || null,
            deployable: reference.deployable === true,
            blocking: reference.blocking === true,
            referenceType: reference.referenceType || null,
            sourceElement: reference.sourceElement || null,
            selected: false,
            required: reference.required !== false
        });

        addEdge(
            edges,
            parentId,
            childId,
            reference.referenceType || 'Reference'
        );
    }

    applyDecisions(nodesById, resolvedDependencies);

    const nodes = [...nodesById.values()].sort((a, b) => {
        const depthCompare = (a.depth || 0) - (b.depth || 0);

        if (depthCompare !== 0) {
            return depthCompare;
        }

        return a.id.localeCompare(b.id);
    });

    const edgeList = [...edges.values()];
    const relationshipTree = buildRelationshipTree(nodesById, edges);
    const graphStatistics = buildGraphStatistics(
        nodes,
        edgeList,
        discoveredReferences
    );

    console.log('Total nodes:', graphStatistics.totalNodes);
    console.log('Relationships:', graphStatistics.relationships);
    console.log('Reference count:', graphStatistics.referenceCount);
    console.log('Graph depth:', graphStatistics.graphDepth);
    console.log('Blocking references:', graphStatistics.blockingReferences);
    console.log(
        'Warnings:',
        warnings.length ? warnings : '(none)'
    );

    logSection('Deployment Dependency Explorer Summary');

    return {
        dependencyExplorer: {
            nodes,
            edges: edgeList,
            warnings
        },
        relationshipTree,
        referenceSummary: referenceSummary || {
            referencesDiscovered: discoveredReferences.length,
            byType: {},
            blockingReferences: graphStatistics.blockingReferences,
            deployableReferences: graphStatistics.deployableReferences,
            warnings: []
        },
        graphStatistics
    };
}

module.exports = {
    buildDependencyExplorer
};
