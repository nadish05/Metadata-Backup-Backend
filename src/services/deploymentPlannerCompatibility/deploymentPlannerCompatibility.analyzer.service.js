/**
 * Planner Compatibility Analyzer — Phase 2C (report-only).
 *
 * Completely isolated from deploymentCompatibility, Package Generation,
 * Workspace, CLI, and Deployment Planner decision mutation.
 *
 * Responsibilities:
 * - Deterministic and pure (no I/O, no HTTP, no filesystem, no Git).
 * - Uses selectedMetadata + resolvedDependencies (+ optional graph inputs).
 * - Does NOT modify any input collections.
 * - Reports analysisLevel based on destination existence analysis.
 * - Reports canSkip capability for EXISTENCE analysis (Phase 4D).
 * - Phase 6B: attaches normalized graph edge info (report-only).
 * - Does NOT encode planner fallback / editable rules.
 * - Does NOT authorize Skip (Trust Policy / Analyzer Executor still decide).
 *
 * Phase 2C / 4D:
 * - existsInDestination === true → analysisLevel EXISTENCE
 * - otherwise → analysisLevel NONE
 * - canSkip capability: EXISTS + EXISTENCE → true; else false
 *
 * Phase 6B:
 * - Graph edges may be attached to rows (graphEdges / graphReasons).
 * - graphSafe stays false (GRAPH safety not evaluated yet).
 * - analysisLevel and canSkip remain EXISTENCE-only.
 */

const ANALYSIS_LEVEL = Object.freeze({
    NONE: 'NONE',
    EXISTENCE: 'EXISTENCE',
    GRAPH: 'GRAPH',
    CONTRACT: 'CONTRACT',
    SEMANTIC: 'SEMANTIC'
});

function getMetadataType(item) {
    return item?.metadataType || item?.type || null;
}

function getMetadataName(item) {
    return item?.metadataName || item?.name || null;
}

function buildKey(metadataType, metadataName) {
    return `${metadataType}:${metadataName}`;
}

function resolveExistsInDestination(destinationState) {
    if (destinationState === 'EXISTS') {
        return true;
    }

    if (destinationState === 'MISSING') {
        return false;
    }

    return null;
}

/**
 * Compute Skip capability for EXISTENCE analysis only.
 * Capability ≠ authorization (Trust Policy / Analyzer Executor authorize).
 *
 * Rules:
 * - analysisLevel NONE → false
 * - analysisLevel not EXISTENCE → false
 * - destinationState EXISTS → true
 * - destinationState MISSING / UNKNOWN / missing → false
 *
 * @param {object} [params]
 * @param {string|null} [params.destinationState]
 * @param {string|null} [params.analysisLevel]
 * @returns {boolean}
 */
function computeCanSkip({
    destinationState = null,
    analysisLevel = null
} = {}) {
    if (analysisLevel === ANALYSIS_LEVEL.NONE || !analysisLevel) {
        return false;
    }

    // Phase 4D: EXISTENCE policy only.
    if (analysisLevel !== ANALYSIS_LEVEL.EXISTENCE) {
        return false;
    }

    if (destinationState === 'EXISTS') {
        return true;
    }

    // MISSING, UNKNOWN, null, or any other value.
    return false;
}

/**
 * Normalize discovery outputs into a per-node edge index.
 * Phase 6B — informational only; does not evaluate graph safety.
 *
 * @param {object} [params]
 * @param {Array<object>} [params.discoveredRelationships]
 * @param {Array<object>} [params.discoveredReferences]
 * @param {Array<object>} [params.discoveredEdges]
 * @returns {{
 *   byNode: Map<string, { dependsOn: Array<object>, requiredBy: Array<object> }>,
 *   edges: Array<object>
 * }}
 */
function normalizeDependencyGraph({
    discoveredRelationships = [],
    discoveredReferences = [],
    discoveredEdges = []
} = {}) {
    const edgeMap = new Map();
    const byNode = new Map();

    function ensureNodeEntry(key) {
        if (!byNode.has(key)) {
            byNode.set(key, { dependsOn: [], requiredBy: [] });
        }

        return byNode.get(key);
    }

    function addNormalizedEdge({
        fromType,
        fromName,
        toType,
        toName,
        relationship = 'Reference',
        source = null
    }) {
        if (!fromType || !fromName || !toType || !toName) {
            return;
        }

        const fromKey = buildKey(fromType, fromName);
        const toKey = buildKey(toType, toName);
        const edgeKey = `${fromKey}->${toKey}:${relationship}`;

        if (edgeMap.has(edgeKey)) {
            return;
        }

        const edge = {
            fromType,
            fromName,
            toType,
            toName,
            relationship,
            source
        };

        edgeMap.set(edgeKey, edge);

        const fromEntry = ensureNodeEntry(fromKey);
        const toEntry = ensureNodeEntry(toKey);

        fromEntry.dependsOn.push({
            metadataType: toType,
            metadataName: toName,
            relationship,
            source
        });

        toEntry.requiredBy.push({
            metadataType: fromType,
            metadataName: fromName,
            relationship,
            source
        });
    }

    for (const edge of discoveredEdges || []) {
        addNormalizedEdge({
            fromType: edge.fromType || edge.fromMetadataType || null,
            fromName: edge.fromName || edge.fromMetadataName || null,
            toType: edge.toType || edge.toMetadataType || null,
            toName: edge.toName || edge.toMetadataName || null,
            relationship: edge.relationship || edge.referenceType || 'Reference',
            source: edge.discoveredBy || 'discoveredEdges'
        });
    }

    for (const relationship of discoveredRelationships || []) {
        const toType = relationship.metadataType || relationship.type || null;
        const toName = relationship.name || null;
        const fromName = relationship.sourceMetadata || null;
        const fromType = fromName ? 'CustomObject' : null;

        addNormalizedEdge({
            fromType,
            fromName,
            toType,
            toName,
            relationship: relationship.relationship || 'RelatedObject',
            source: relationship.discoveredBy || 'discoveredRelationships'
        });
    }

    for (const reference of discoveredReferences || []) {
        const toType = reference.metadataType || reference.type || null;
        const toName = reference.name || null;
        const fromName = reference.sourceMetadata || null;
        // FlexiPage is the primary reference discoverer source today.
        const fromType = fromName
            ? reference.sourceMetadataType || 'FlexiPage'
            : null;

        addNormalizedEdge({
            fromType,
            fromName,
            toType,
            toName,
            relationship:
                reference.referenceType || reference.relationship || 'Reference',
            source: reference.discoveredBy || 'discoveredReferences'
        });
    }

    return {
        byNode,
        edges: [...edgeMap.values()]
    };
}

function getNodeGraphAttachment(graphIndex, metadataType, metadataName) {
    const empty = {
        graphSafe: false,
        graphReasons: ['No graph edges attached for this metadata.'],
        graphEdges: {
            dependsOn: [],
            requiredBy: []
        }
    };

    if (!metadataType || !metadataName || !graphIndex?.byNode) {
        return empty;
    }

    const entry = graphIndex.byNode.get(buildKey(metadataType, metadataName));

    if (!entry) {
        return empty;
    }

    const dependsOn = [...(entry.dependsOn || [])];
    const requiredBy = [...(entry.requiredBy || [])];
    const hasEdges = dependsOn.length > 0 || requiredBy.length > 0;

    return {
        // Phase 6B: GRAPH safety is not evaluated — informational wiring only.
        graphSafe: false,
        graphReasons: hasEdges
            ? [
                  'Graph edges attached; GRAPH safety not evaluated (Phase 6B).'
              ]
            : ['No graph edges attached for this metadata.'],
        graphEdges: {
            dependsOn,
            requiredBy
        }
    };
}

/**
 * Build a planner compatibility row using destination existence analysis.
 * canSkip is capability only (Phase 4D); it does not authorize Skip.
 * Graph fields are Phase 6B report-only attachments.
 */
function buildCompatibilityResult(item, graphIndex = null) {
    const metadataType = getMetadataType(item);
    const metadataName = getMetadataName(item);
    const destinationState = item?.destinationState || null;
    const existsInDestination = resolveExistsInDestination(destinationState);

    const exists = existsInDestination === true;
    const analysisLevel = exists
        ? ANALYSIS_LEVEL.EXISTENCE
        : ANALYSIS_LEVEL.NONE;

    const graphAttachment = getNodeGraphAttachment(
        graphIndex,
        metadataType,
        metadataName
    );

    return {
        metadataType,
        metadataName,
        existsInDestination,
        graphSafe: graphAttachment.graphSafe,
        graphReasons: graphAttachment.graphReasons,
        graphEdges: graphAttachment.graphEdges,
        canSkip: computeCanSkip({
            destinationState,
            analysisLevel
        }),
        analysisLevel,
        reason: exists
            ? 'Destination metadata located.'
            : 'Metadata not found in destination.'
    };
}

function collectInventory(selectedMetadata, resolvedDependencies) {
    const inventory = new Map();

    function addItem(item) {
        const metadataType = getMetadataType(item);
        const metadataName = getMetadataName(item);

        if (!metadataType || !metadataName) {
            return;
        }

        const key = buildKey(metadataType, metadataName);
        const existing = inventory.get(key);

        // Prefer resolved dependency decisions when both collections contain
        // the same component (they carry destinationState / action).
        if (!existing || item?.destinationState || item?.action) {
            inventory.set(key, {
                ...(existing || {}),
                ...item,
                metadataType,
                metadataName
            });
        }
    }

    for (const item of selectedMetadata || []) {
        addItem(item);
    }

    for (const item of resolvedDependencies || []) {
        addItem(item);
    }

    return [...inventory.values()].sort((a, b) => {
        const typeCompare = String(a.metadataType).localeCompare(
            String(b.metadataType)
        );

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return String(a.metadataName).localeCompare(String(b.metadataName));
    });
}

function buildSummary(results, graphIndex = null) {
    let canSkip = 0;
    let cannotSkip = 0;
    let unknown = 0;

    for (const result of results) {
        if (result.canSkip === true) {
            canSkip += 1;
        } else if (
            result.existsInDestination === false ||
            result.graphSafe === false
        ) {
            cannotSkip += 1;
        } else {
            unknown += 1;
        }
    }

    return {
        analyzed: results.length,
        canSkip,
        cannotSkip,
        unknown,
        // Phase 6B informational — does not affect planner.
        graphEdgesAttached: Array.isArray(graphIndex?.edges)
            ? graphIndex.edges.length
            : 0,
        graphNodesTouched: graphIndex?.byNode ? graphIndex.byNode.size : 0
    };
}

/**
 * Analyze planner compatibility (read-only report).
 *
 * @param {object} params
 * @param {Array<object>} [params.selectedMetadata]
 * @param {Array<object>} [params.resolvedDependencies]
 * @param {Array<object>} [params.discoveredRelationships]
 * @param {Array<object>} [params.discoveredReferences]
 * @param {Array<object>} [params.discoveredEdges]
 * @returns {{ plannerCompatibility: { results: Array<object>, summary: object } }}
 */
function analyzePlannerCompatibility({
    selectedMetadata = [],
    resolvedDependencies = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    discoveredEdges = []
} = {}) {
    const inventory = collectInventory(
        Array.isArray(selectedMetadata) ? selectedMetadata : [],
        Array.isArray(resolvedDependencies) ? resolvedDependencies : []
    );

    const graphIndex = normalizeDependencyGraph({
        discoveredRelationships: Array.isArray(discoveredRelationships)
            ? discoveredRelationships
            : [],
        discoveredReferences: Array.isArray(discoveredReferences)
            ? discoveredReferences
            : [],
        discoveredEdges: Array.isArray(discoveredEdges) ? discoveredEdges : []
    });

    const results = inventory.map((item) =>
        buildCompatibilityResult(item, graphIndex)
    );

    return {
        plannerCompatibility: {
            results,
            summary: buildSummary(results, graphIndex)
        }
    };
}

module.exports = {
    ANALYSIS_LEVEL,
    computeCanSkip,
    normalizeDependencyGraph,
    analyzePlannerCompatibility
};
