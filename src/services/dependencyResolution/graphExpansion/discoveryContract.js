/**
 * Shared discovery contract for Metadata Graph Expansion.
 * All type discoverers must return this shape.
 */

function createEmptyDiscoveryResult(statistics = {}) {
    return {
        discoveredNodes: [],
        discoveredEdges: [],
        warnings: [],
        statistics: { ...statistics }
    };
}

function createGraphNode({
    name,
    metadataType,
    deployable = true,
    blocking = true,
    sourceMetadata = null,
    discoveredBy = null,
    discoveryMethod = null,
    referenceType = null,
    relationship = null,
    reason = null,
    depth = 1,
    filePath = null
}) {
    return {
        name,
        metadataType,
        type: metadataType,
        deployable: deployable === true,
        blocking: blocking === true,
        sourceMetadata,
        discoveredBy,
        discoveryMethod,
        referenceType,
        relationship,
        reason,
        depth,
        filePath
    };
}

function createGraphEdge({
    fromType,
    fromName,
    toType,
    toName,
    relationship = 'Reference',
    discoveredBy = null,
    reason = null
}) {
    return {
        fromType,
        fromName,
        toType,
        toName,
        relationship,
        discoveredBy,
        reason
    };
}

function getNodeKey(node) {
    const type = node?.metadataType || node?.type;
    const name = node?.name || node?.metadataName;

    if (!type || !name) {
        return null;
    }

    return `${type}:${name}`;
}

function getEdgeKey(edge) {
    if (!edge?.fromType || !edge?.fromName || !edge?.toType || !edge?.toName) {
        return null;
    }

    return `${edge.fromType}:${edge.fromName}->${edge.toType}:${edge.toName}:${edge.relationship || 'Reference'}`;
}

module.exports = {
    createEmptyDiscoveryResult,
    createGraphNode,
    createGraphEdge,
    getNodeKey,
    getEdgeKey
};
