const { buildGraphNodeId } = require('../dependencyResolution/graphId');
const {
    ACTIONS,
    DESTINATION_STATES
} = require('../dependencyResolution/decisionModel');

function getMetadataType(item) {
    return item?.metadataType || item?.type || null;
}

function getMetadataName(item) {
    return item?.metadataName || item?.name || null;
}

/**
 * Build availability index for compatibility checks.
 * A node is available when selected, scheduled for DEPLOY, or known to EXIST
 * in destination (REFERENCE).
 */
function buildAvailabilityIndex({
    selectedMetadata = [],
    resolvedDependencies = [],
    discoveredRelationships = []
} = {}) {
    const available = new Map();
    const decisionsById = new Map();

    function markAvailable(metadataType, name, source) {
        const id = buildGraphNodeId(metadataType, name);

        if (!id) {
            return;
        }

        if (!available.has(id)) {
            available.set(id, { id, metadataType, name, source });
        }
    }

    for (const item of selectedMetadata) {
        const metadataType = getMetadataType(item);
        const name = getMetadataName(item);

        if (metadataType && name) {
            markAvailable(metadataType, name, 'SELECTED');
        }
    }

    for (const decision of resolvedDependencies) {
        const metadataType = getMetadataType(decision);
        const name = getMetadataName(decision);
        const id = buildGraphNodeId(metadataType, name);

        if (!id) {
            continue;
        }

        decisionsById.set(id, decision);

        if (decision.action === ACTIONS.DEPLOY && decision.selected !== false) {
            markAvailable(metadataType, name, 'DEPLOY');
            continue;
        }

        if (
            decision.action === ACTIONS.REFERENCE &&
            decision.destinationState === DESTINATION_STATES.EXISTS
        ) {
            markAvailable(metadataType, name, 'EXISTS');
        }
    }

    // Discovered relationship targets are part of the graph, but only count as
    // available when also selected/deployed/existing via decisions above.
    const graphIds = new Set([...available.keys()]);

    for (const relationship of discoveredRelationships) {
        const metadataType = getMetadataType(relationship);
        const name = getMetadataName(relationship);
        const id = buildGraphNodeId(metadataType, name);

        if (id) {
            graphIds.add(id);
        }
    }

    return {
        available,
        decisionsById,
        graphIds,
        isAvailable(metadataType, name) {
            const id = buildGraphNodeId(metadataType, name);
            return Boolean(id && available.has(id));
        },
        getDecision(metadataType, name) {
            const id = buildGraphNodeId(metadataType, name);
            return id ? decisionsById.get(id) || null : null;
        }
    };
}

module.exports = {
    buildAvailabilityIndex,
    getMetadataType,
    getMetadataName
};
