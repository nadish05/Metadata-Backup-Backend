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
 * - Phase 6C/6E: evaluates graphSafe (report-only; does not change decisions).
 * - Phase 6F: graphSafe synchronized to effective package after planner.
 * - Does NOT encode planner fallback / editable rules.
 * - Does NOT authorize Skip (Trust Policy / Analyzer Executor still decide).
 *
 * Phase 2C / 4D:
 * - existsInDestination === true → analysisLevel EXISTENCE
 * - otherwise → analysisLevel NONE
 * - canSkip capability: EXISTS + EXISTENCE → true; else false
 *
 * Phase 6B / 6C / 6E / 6F:
 * - Graph edges attached; graphSafe from transitive blocking dependsOn closure.
 * - Package membership for graphSafe uses the effective deploy set (post-planner).
 * - analysisLevel and canSkip remain EXISTENCE-only.
 *
 * Phase 7B:
 * - Compatibility rows expose a capabilities map (facts only).
 * - Does not authorize Skip; planner routing unchanged.
 *
 * Phase 9C:
 * - CONTRACT facts for CustomField via source vs destination shape.
 */

const {
    evaluateContractCapability
} = require('./contract/contractEvaluator.service');

const ANALYSIS_LEVEL = Object.freeze({
    NONE: 'NONE',
    EXISTENCE: 'EXISTENCE',
    GRAPH: 'GRAPH',
    CONTRACT: 'CONTRACT',
    SEMANTIC: 'SEMANTIC'
});

/**
 * Capability evaluation statuses (facts only — not authorization).
 */
const CAPABILITY_STATUS = Object.freeze({
    PASS: 'PASS',
    FAIL: 'FAIL',
    UNKNOWN: 'UNKNOWN',
    DEFERRED: 'DEFERRED',
    NOT_EVALUATED: 'NOT_EVALUATED'
});

const CAPABILITY_IDS = Object.freeze({
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
 * Build one capability fact entry.
 * Does not authorize Skip or encode planner policy.
 *
 * @param {object} params
 * @param {string} params.status
 * @param {object} [params.evidence]
 * @param {string|null} [params.reason]
 * @returns {{ status: string, evidence: object, reason: string|null }}
 */
function buildCapabilityEntry({
    status,
    evidence = {},
    reason = null,
    authorizationReady = true
} = {}) {
    return {
        status,
        evidence: evidence && typeof evidence === 'object' ? { ...evidence } : {},
        reason: reason || null,
        authorizationReady: authorizationReady === true
    };
}

/**
 * Phase 7B / 9C — assemble capability facts from analyzer outputs.
 * EXISTENCE / GRAPH populated; CONTRACT evaluated for CustomField (Phase 9C);
 * SEMANTIC remain NOT_EVALUATED.
 *
 * @param {object} params
 * @returns {object}
 */
function buildCapabilities({
    destinationState = null,
    existsInDestination = null,
    graphSafe = false,
    graphReasons = [],
    graphEvaluation = null,
    graphDeferred = false,
    metadataType = null,
    metadataName = null,
    destinationShapeIndex = null,
    sourceShapeIndex = null
} = {}) {
    let existenceStatus = CAPABILITY_STATUS.UNKNOWN;
    let existenceReason = 'Destination existence is unknown.';

    if (existsInDestination === true || destinationState === 'EXISTS') {
        existenceStatus = CAPABILITY_STATUS.PASS;
        existenceReason = 'Destination metadata located.';
    } else if (
        existsInDestination === false ||
        destinationState === 'MISSING'
    ) {
        existenceStatus = CAPABILITY_STATUS.FAIL;
        existenceReason = 'Metadata not found in destination.';
    }

    let graphStatus = CAPABILITY_STATUS.NOT_EVALUATED;
    let graphReason = 'Graph capability not evaluated.';

    if (graphDeferred === true) {
        graphStatus = CAPABILITY_STATUS.DEFERRED;
        graphReason =
            Array.isArray(graphReasons) && graphReasons.length
                ? graphReasons[0]
                : 'Graph evaluation deferred until effective package (Phase 6F).';
    } else if (graphSafe === true) {
        graphStatus = CAPABILITY_STATUS.PASS;
        graphReason =
            Array.isArray(graphReasons) && graphReasons.length
                ? graphReasons[0]
                : 'Graph closure is safe.';
    } else if (graphEvaluation?.status === 'UNKNOWN') {
        graphStatus = CAPABILITY_STATUS.UNKNOWN;
        graphReason =
            Array.isArray(graphReasons) && graphReasons.length
                ? graphReasons[0]
                : 'Graph evaluation inconclusive.';
    } else {
        graphStatus = CAPABILITY_STATUS.FAIL;
        graphReason =
            Array.isArray(graphReasons) && graphReasons.length
                ? graphReasons[0]
                : 'Graph closure is not safe.';
    }

    const contractCapability = evaluateContractCapability({
        metadataType,
        metadataName,
        existsInDestination,
        destinationShapeIndex,
        sourceShapeIndex
    });

    const graphAuthorizationReady =
        graphDeferred !== true &&
        graphStatus !== CAPABILITY_STATUS.NOT_EVALUATED;
    const contractAuthorizationReady =
        contractCapability?.status !== CAPABILITY_STATUS.DEFERRED &&
        contractCapability?.status !== CAPABILITY_STATUS.NOT_EVALUATED;

    return {
        [CAPABILITY_IDS.EXISTENCE]: buildCapabilityEntry({
            status: existenceStatus,
            evidence: {
                destinationState: destinationState || null,
                existsInDestination
            },
            reason: existenceReason,
            authorizationReady: true
        }),
        [CAPABILITY_IDS.GRAPH]: buildCapabilityEntry({
            status: graphStatus,
            evidence: {
                graphSafe: graphSafe === true,
                graphEvaluationStatus: graphEvaluation?.status || null,
                blockingDependsOn: graphEvaluation?.blockingDependsOn ?? null,
                dependsOnChecked: graphEvaluation?.dependsOnChecked ?? null,
                dependsOnSatisfied: graphEvaluation?.dependsOnSatisfied ?? null,
                truncated: graphEvaluation?.truncated === true,
                unresolvedCount: Array.isArray(graphEvaluation?.unresolved)
                    ? graphEvaluation.unresolved.length
                    : 0
            },
            reason: graphReason,
            authorizationReady: graphAuthorizationReady
        }),
        [CAPABILITY_IDS.CONTRACT]: {
            ...contractCapability,
            authorizationReady: contractAuthorizationReady
        },
        [CAPABILITY_IDS.SEMANTIC]: buildCapabilityEntry({
            status: CAPABILITY_STATUS.NOT_EVALUATED,
            evidence: {},
            reason: 'SEMANTIC capability is not evaluated yet.',
            authorizationReady: false
        })
    };
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

/**
 * Build package membership keys from generateDeploymentPackage() output.
 * Reuses the composed deploy set — avoids re-implementing package rules.
 *
 * @param {object|null} generatedDeploymentPackage
 * @returns {Set<string>}
 */
function buildPackageMembershipKeysFromGeneratedPackage(
    generatedDeploymentPackage
) {
    const keys = new Set();

    for (const item of generatedDeploymentPackage?.metadata || []) {
        const metadataType = item?.metadataType || null;
        const metadataName = item?.metadataName || item?.name || null;

        if (metadataType && metadataName) {
            keys.add(buildKey(metadataType, metadataName));
        }
    }

    for (const item of generatedDeploymentPackage?.dependencies || []) {
        const metadataType = item?.type || item?.metadataType || null;
        const metadataName = item?.name || item?.metadataName || null;

        if (metadataType && metadataName) {
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
 * Graph fields are Phase 6B–6F report-only.
 * Phase 7B: capabilities map is facts-only (no authorization).
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

    const includeGraphEvaluation =
        evaluationContext.includeGraphEvaluation !== false;

    let graphSafe = false;
    let graphReasons = [
        'Graph evaluation deferred until effective package (Phase 6F).'
    ];
    let graphEdges = { dependsOn: [], requiredBy: [] };
    let graphEvaluation = {
        status: 'DEFERRED',
        truncated: false,
        hasGraphNode: false,
        blockingDependsOn: 0,
        dependsOnChecked: 0,
        dependsOnSatisfied: 0,
        transitive: true,
        maxDepthReached: 0,
        cycleSkips: 0,
        unresolved: []
    };

    if (includeGraphEvaluation) {
        const graphResult = evaluateGraphSafety({
            metadataType,
            metadataName,
            graphIndex: evaluationContext.graphIndex || null,
            stateByKey: evaluationContext.stateByKey || null,
            packageKeys: evaluationContext.packageKeys || null,
            graphTruncated: evaluationContext.graphTruncated === true
        });

        graphSafe = graphResult.graphSafe;
        graphReasons = graphResult.graphReasons;
        graphEdges = graphResult.graphEdges;
        graphEvaluation = graphResult.graphEvaluation;
    }

    const capabilities = buildCapabilities({
        destinationState,
        existsInDestination,
        graphSafe,
        graphReasons,
        graphEvaluation,
        graphDeferred: includeGraphEvaluation !== true,
        metadataType,
        metadataName,
        destinationShapeIndex: evaluationContext.destinationShapeIndex || null,
        sourceShapeIndex: evaluationContext.sourceShapeIndex || null
    });

    return {
        metadataType,
        metadataName,
        // Propagate analyzer destination facts for planner authorization wiring.
        // Planner already reads plannerCompatibilityRow.destinationState.
        destinationState,
        existsInDestination,
        graphSafe,
        graphReasons,
        graphEdges,
        graphEvaluation,
        capabilities,
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
 * @param {boolean} [params.includeGraphEvaluation=true]
 * @param {Set<string>|null} [params.packageMembershipKeys] - optional override
 * @param {object|null} [params.destinationShapeIndex]
 * @param {Map|object|null} [params.sourceShapeIndex]
 * @returns {{ plannerCompatibility: { results: Array<object>, summary: object } }}
 */
function analyzePlannerCompatibility({
    selectedMetadata = [],
    resolvedDependencies = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    discoveredEdges = [],
    graphTruncated = false,
    includeGraphEvaluation = true,
    packageMembershipKeys = null,
    destinationShapeIndex = null,
    sourceShapeIndex = null
} = {}) {
    const selected = Array.isArray(selectedMetadata) ? selectedMetadata : [];
    const resolved = Array.isArray(resolvedDependencies)
        ? resolvedDependencies
        : [];

    const inventory = collectInventory(selected, resolved);

    const graphIndex = includeGraphEvaluation
        ? normalizeDependencyGraph({
              discoveredRelationships: Array.isArray(discoveredRelationships)
                  ? discoveredRelationships
                  : [],
              discoveredReferences: Array.isArray(discoveredReferences)
                  ? discoveredReferences
                  : [],
              discoveredEdges: Array.isArray(discoveredEdges)
                  ? discoveredEdges
                  : []
          })
        : { byNode: new Map(), edges: [] };

    const evaluationContext = {
        graphIndex,
        stateByKey: buildDestinationStateIndex(inventory),
        packageKeys:
            packageMembershipKeys instanceof Set
                ? packageMembershipKeys
                : buildPackageMembershipKeys(selected, resolved),
        graphTruncated: graphTruncated === true,
        includeGraphEvaluation: includeGraphEvaluation !== false,
        destinationShapeIndex,
        sourceShapeIndex
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

/**
 * Phase 6F — refresh graphSafe fields using the effective deployment package.
 * Preserves analysisLevel / canSkip / existsInDestination from the original report.
 *
 * @param {object|null} plannerCompatibilityReport
 * @param {object} params
 * @returns {object|null}
 */
function synchronizePlannerCompatibilityGraph(
    plannerCompatibilityReport,
    {
        selectedMetadata = [],
        resolvedDependencies = [],
        discoveredRelationships = [],
        discoveredReferences = [],
        discoveredEdges = [],
        graphTruncated = false,
        packageMembershipKeys = null,
        generatedDeploymentPackage = null,
        destinationShapeIndex = null,
        sourceShapeIndex = null
    } = {}
) {
    const results = plannerCompatibilityReport?.plannerCompatibility?.results;

    if (!Array.isArray(results)) {
        return plannerCompatibilityReport;
    }

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

    let packageKeys = packageMembershipKeys;

    if (!(packageKeys instanceof Set)) {
        packageKeys = generatedDeploymentPackage
            ? buildPackageMembershipKeysFromGeneratedPackage(
                  generatedDeploymentPackage
              )
            : buildPackageMembershipKeys(selected, resolved);
    }

    const stateByKey = buildDestinationStateIndex(inventory);
    const truncated = graphTruncated === true;

    const synchronizedResults = results.map((row) => {
        const graphResult = evaluateGraphSafety({
            metadataType: row.metadataType,
            metadataName: row.metadataName,
            graphIndex,
            stateByKey,
            packageKeys,
            graphTruncated: truncated
        });

        const capabilities = buildCapabilities({
            destinationState:
                stateByKey.get(
                    buildKey(row.metadataType, row.metadataName)
                ) || null,
            existsInDestination: row.existsInDestination,
            graphSafe: graphResult.graphSafe,
            graphReasons: graphResult.graphReasons,
            graphEvaluation: graphResult.graphEvaluation,
            graphDeferred: false,
            metadataType: row.metadataType,
            metadataName: row.metadataName,
            destinationShapeIndex,
            sourceShapeIndex
        });

        return {
            ...row,
            graphSafe: graphResult.graphSafe,
            graphReasons: graphResult.graphReasons,
            graphEdges: graphResult.graphEdges,
            graphEvaluation: graphResult.graphEvaluation,
            capabilities
        };
    });

    return {
        plannerCompatibility: {
            results: synchronizedResults,
            summary: buildSummary(synchronizedResults, graphIndex)
        }
    };
}

module.exports = {
    ANALYSIS_LEVEL,
    CAPABILITY_STATUS,
    CAPABILITY_IDS,
    computeCanSkip,
    buildCapabilities,
    normalizeDependencyGraph,
    evaluateGraphSafety,
    buildPackageMembershipKeysFromGeneratedPackage,
    analyzePlannerCompatibility,
    synchronizePlannerCompatibilityGraph
};
