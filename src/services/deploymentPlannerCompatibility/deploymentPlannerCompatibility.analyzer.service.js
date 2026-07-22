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
 * - Phase 6C: evaluates graphSafe (report-only; does not change decisions).
 * - Does NOT encode planner fallback / editable rules.
 * - Does NOT authorize Skip (Trust Policy / Analyzer Executor still decide).
 *
 * Phase 2C / 4D:
 * - existsInDestination === true → analysisLevel EXISTENCE
 * - otherwise → analysisLevel NONE
 * - canSkip capability: EXISTS + EXISTENCE → true; else false
 *
 * Phase 6B / 6C / 6E:
 * - Graph edges attached; graphSafe from transitive blocking dependsOn closure.
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
        source = null,
        blocking = true
    }) {
        if (!fromType || !fromName || !toType || !toName) {
            return;
        }

        const fromKey = buildKey(fromType, fromName);
        const toKey = buildKey(toType, toName);
        const edgeKey = `${fromKey}->${toKey}:${relationship}`;
        const isBlocking = blocking !== false;

        if (edgeMap.has(edgeKey)) {
            return;
        }

        const edge = {
            fromType,
            fromName,
            toType,
            toName,
            relationship,
            source,
            blocking: isBlocking
        };

        edgeMap.set(edgeKey, edge);

        const fromEntry = ensureNodeEntry(fromKey);
        const toEntry = ensureNodeEntry(toKey);

        fromEntry.dependsOn.push({
            metadataType: toType,
            metadataName: toName,
            relationship,
            source,
            blocking: isBlocking
        });

        toEntry.requiredBy.push({
            metadataType: fromType,
            metadataName: fromName,
            relationship,
            source,
            blocking: isBlocking
        });
    }

    for (const edge of discoveredEdges || []) {
        addNormalizedEdge({
            fromType: edge.fromType || edge.fromMetadataType || null,
            fromName: edge.fromName || edge.fromMetadataName || null,
            toType: edge.toType || edge.toMetadataType || null,
            toName: edge.toName || edge.toMetadataName || null,
            relationship: edge.relationship || edge.referenceType || 'Reference',
            source: edge.discoveredBy || 'discoveredEdges',
            blocking: edge.blocking !== false
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
            source: relationship.discoveredBy || 'discoveredRelationships',
            // required !== false → blocking (conservative default).
            blocking: relationship.required !== false && relationship.blocking !== false
        });
    }

    for (const reference of discoveredReferences || []) {
        const toType = reference.metadataType || reference.type || null;
        const toName = reference.name || null;
        const fromName = reference.sourceMetadata || null;
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
            source: reference.discoveredBy || 'discoveredReferences',
            blocking: reference.blocking !== false
        });
    }

    return {
        byNode,
        edges: [...edgeMap.values()]
    };
}

/**
 * Keys that would be included in the deployment package (pre-package-gen view).
 * Mirrors package generation auto-include rules without calling package service.
 */
function buildPackageMembershipKeys(selectedMetadata, resolvedDependencies) {
    const keys = new Set();

    for (const item of selectedMetadata || []) {
        const metadataType = getMetadataType(item);
        const metadataName = getMetadataName(item);

        if (!metadataType || !metadataName) {
            continue;
        }

        // Primary inventory members present in selectedMetadata are package seeds.
        // Planner may later remove skipped primaries; analyzer runs before that.
        if (item.selected === false) {
            continue;
        }

        keys.add(buildKey(metadataType, metadataName));
    }

    for (const item of resolvedDependencies || []) {
        const metadataType = getMetadataType(item);
        const metadataName = getMetadataName(item);

        if (!metadataType || !metadataName) {
            continue;
        }

        let included = false;

        if (item.action) {
            included =
                item.action === 'DEPLOY' && item.selected === true;
        } else {
            included =
                item.required !== false && item.selected !== false;
        }

        if (included) {
            keys.add(buildKey(metadataType, metadataName));
        }
    }

    return keys;
}

function buildDestinationStateIndex(inventoryItems) {
    const stateByKey = new Map();

    for (const item of inventoryItems || []) {
        const metadataType = getMetadataType(item);
        const metadataName = getMetadataName(item);

        if (!metadataType || !metadataName) {
            continue;
        }

        stateByKey.set(
            buildKey(metadataType, metadataName),
            item.destinationState || null
        );
    }

    return stateByKey;
}

/**
 * Align with graph expansion depth cap — stay conservative beyond this.
 * @see graphExpansion.service.js MAX_GRAPH_DEPTH
 */
const MAX_GRAPH_EVAL_DEPTH = 10;

/**
 * Phase 6C/6E — evaluate whether the transitive blocking dependsOn closure
 * is satisfied. Conservative: truncated / unknown / incomplete / depth-exceeded
 * never yields graphSafe=true. Cycles are skipped via a visited set.
 */
function evaluateGraphSafety({
    metadataType,
    metadataName,
    graphIndex,
    stateByKey,
    packageKeys,
    graphTruncated = false
} = {}) {
    const emptyEdges = { dependsOn: [], requiredBy: [] };
    const key =
        metadataType && metadataName
            ? buildKey(metadataType, metadataName)
            : null;
    const entry = key && graphIndex?.byNode ? graphIndex.byNode.get(key) : null;
    const dependsOn = entry ? [...(entry.dependsOn || [])] : [];
    const requiredBy = entry ? [...(entry.requiredBy || [])] : [];

    const graphEvaluation = {
        status: 'UNKNOWN',
        truncated: graphTruncated === true,
        hasGraphNode: Boolean(entry),
        blockingDependsOn: 0,
        dependsOnChecked: 0,
        dependsOnSatisfied: 0,
        transitive: true,
        maxDepthReached: 0,
        cycleSkips: 0,
        unresolved: []
    };

    if (graphTruncated === true) {
        return {
            graphSafe: false,
            graphReasons: [
                'Graph evaluation incomplete: discovery truncated.'
            ],
            graphEdges: { dependsOn, requiredBy },
            graphEvaluation
        };
    }

    if (!entry) {
        return {
            graphSafe: false,
            graphReasons: ['No graph edges attached for this metadata.'],
            graphEdges: emptyEdges,
            graphEvaluation
        };
    }

    const blockingDeps = dependsOn.filter((dep) => dep.blocking !== false);
    graphEvaluation.blockingDependsOn = blockingDeps.length;

    if (blockingDeps.length === 0) {
        return {
            graphSafe: true,
            graphReasons: [
                'No blocking dependsOn edges; graph closure is vacuously safe.'
            ],
            graphEdges: { dependsOn, requiredBy },
            graphEvaluation: {
                ...graphEvaluation,
                status: 'SAFE'
            }
        };
    }

    const reasons = [];
    let sawUnknown = false;
    let depthExceeded = false;

    // Root is visited so cyclic edges back to the start node are skipped.
    const visited = new Set([key]);
    const queue = blockingDeps.map((dep) => ({
        metadataType: dep.metadataType,
        metadataName: dep.metadataName,
        relationship: dep.relationship || null,
        depth: 1
    }));

    while (queue.length > 0) {
        const current = queue.shift();
        const depKey = buildKey(current.metadataType, current.metadataName);

        if (!current.metadataType || !current.metadataName) {
            sawUnknown = true;
            graphEvaluation.unresolved.push({
                metadataType: current.metadataType,
                metadataName: current.metadataName,
                relationship: current.relationship,
                reason: 'UNKNOWN_OR_ABSENT'
            });
            reasons.push(
                'Blocking dependency has incomplete identity and cannot be evaluated.'
            );
            continue;
        }

        if (visited.has(depKey)) {
            graphEvaluation.cycleSkips += 1;
            continue;
        }

        visited.add(depKey);

        if (current.depth > MAX_GRAPH_EVAL_DEPTH) {
            depthExceeded = true;
            graphEvaluation.truncated = true;
            graphEvaluation.unresolved.push({
                metadataType: current.metadataType,
                metadataName: current.metadataName,
                relationship: current.relationship,
                reason: 'DEPTH_EXCEEDED'
            });
            reasons.push(
                `Graph evaluation stopped at maximum depth ${MAX_GRAPH_EVAL_DEPTH} (reached ${depKey}).`
            );
            break;
        }

        if (current.depth > graphEvaluation.maxDepthReached) {
            graphEvaluation.maxDepthReached = current.depth;
        }

        graphEvaluation.dependsOnChecked += 1;

        const destinationState = stateByKey?.get(depKey);
        const exists = destinationState === 'EXISTS';
        const inPackage = packageKeys?.has(depKey) === true;

        if (!exists && !inPackage) {
            if (destinationState === 'MISSING') {
                graphEvaluation.unresolved.push({
                    metadataType: current.metadataType,
                    metadataName: current.metadataName,
                    relationship: current.relationship,
                    reason: 'MISSING_NOT_IN_PACKAGE'
                });
                reasons.push(
                    `Blocking dependency ${depKey} is MISSING and not in package.`
                );
            } else {
                sawUnknown = true;
                graphEvaluation.unresolved.push({
                    metadataType: current.metadataType,
                    metadataName: current.metadataName,
                    relationship: current.relationship,
                    reason: 'UNKNOWN_OR_ABSENT'
                });
                reasons.push(
                    `Blocking dependency ${depKey} has unknown destination state and is not in package.`
                );
            }

            // Unsatisfied node — do not expand further through it.
            continue;
        }

        graphEvaluation.dependsOnSatisfied += 1;

        const depEntry = graphIndex.byNode.get(depKey);

        if (!depEntry) {
            sawUnknown = true;
            graphEvaluation.unresolved.push({
                metadataType: current.metadataType,
                metadataName: current.metadataName,
                relationship: current.relationship,
                reason: 'MISSING_GRAPH_NODE'
            });
            reasons.push(
                `Blocking dependency ${depKey} has no graph node for transitive evaluation.`
            );
            continue;
        }

        const nextBlocking = (depEntry.dependsOn || []).filter(
            (dep) => dep.blocking !== false
        );

        for (const next of nextBlocking) {
            const nextKey = buildKey(next.metadataType, next.metadataName);

            if (visited.has(nextKey)) {
                graphEvaluation.cycleSkips += 1;
                continue;
            }

            queue.push({
                metadataType: next.metadataType,
                metadataName: next.metadataName,
                relationship: next.relationship || null,
                depth: current.depth + 1
            });
        }
    }

    if (depthExceeded) {
        return {
            graphSafe: false,
            graphReasons: reasons,
            graphEdges: { dependsOn, requiredBy },
            graphEvaluation: {
                ...graphEvaluation,
                status: 'UNKNOWN'
            }
        };
    }

    if (graphEvaluation.unresolved.length === 0) {
        return {
            graphSafe: true,
            graphReasons: [
                'All reachable blocking dependsOn edges EXISTS or included in package.'
            ],
            graphEdges: { dependsOn, requiredBy },
            graphEvaluation: {
                ...graphEvaluation,
                status: 'SAFE'
            }
        };
    }

    return {
        graphSafe: false,
        graphReasons: reasons,
        graphEdges: { dependsOn, requiredBy },
        graphEvaluation: {
            ...graphEvaluation,
            status: sawUnknown ? 'UNKNOWN' : 'UNSAFE'
        }
    };
}

/**
 * Build a planner compatibility row using destination existence analysis.
 * canSkip is capability only (Phase 4D); it does not authorize Skip.
 * Graph fields are Phase 6B/6C/6E report-only.
 */
function buildCompatibilityResult(item, evaluationContext = {}) {
    const metadataType = getMetadataType(item);
    const metadataName = getMetadataName(item);
    const destinationState = item?.destinationState || null;
    const existsInDestination = resolveExistsInDestination(destinationState);

    const exists = existsInDestination === true;
    const analysisLevel = exists
        ? ANALYSIS_LEVEL.EXISTENCE
        : ANALYSIS_LEVEL.NONE;

    const graphResult = evaluateGraphSafety({
        metadataType,
        metadataName,
        graphIndex: evaluationContext.graphIndex || null,
        stateByKey: evaluationContext.stateByKey || null,
        packageKeys: evaluationContext.packageKeys || null,
        graphTruncated: evaluationContext.graphTruncated === true
    });

    return {
        metadataType,
        metadataName,
        existsInDestination,
        graphSafe: graphResult.graphSafe,
        graphReasons: graphResult.graphReasons,
        graphEdges: graphResult.graphEdges,
        graphEvaluation: graphResult.graphEvaluation,
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
    let graphSafe = 0;

    for (const result of results) {
        if (result.graphSafe === true) {
            graphSafe += 1;
        }

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
        graphSafe,
        // Phase 6B/6C informational — does not affect planner.
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
 * @param {boolean} [params.graphTruncated]
 * @returns {{ plannerCompatibility: { results: Array<object>, summary: object } }}
 */
function analyzePlannerCompatibility({
    selectedMetadata = [],
    resolvedDependencies = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    discoveredEdges = [],
    graphTruncated = false
} = {}) {
    const selected = Array.isArray(selectedMetadata) ? selectedMetadata : [];
    const resolved = Array.isArray(resolvedDependencies)
        ? resolvedDependencies
        : [];

    const inventory = collectInventory(selected, resolved);

    const graphIndex = normalizeDependencyGraph({
        discoveredRelationships: Array.isArray(discoveredRelationships)
            ? discoveredRelationships
            : [],
        discoveredReferences: Array.isArray(discoveredReferences)
            ? discoveredReferences
            : [],
        discoveredEdges: Array.isArray(discoveredEdges) ? discoveredEdges : []
    });

    const evaluationContext = {
        graphIndex,
        stateByKey: buildDestinationStateIndex(inventory),
        packageKeys: buildPackageMembershipKeys(selected, resolved),
        graphTruncated: graphTruncated === true
    };

    const results = inventory.map((item) =>
        buildCompatibilityResult(item, evaluationContext)
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
    evaluateGraphSafety,
    analyzePlannerCompatibility
};
