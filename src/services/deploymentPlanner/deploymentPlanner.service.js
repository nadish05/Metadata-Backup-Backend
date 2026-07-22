/**
 * Deployment Planner service.
 *
 * Applies user Deploy/Skip preferences to:
 * - selectedMetadata (primary inventory)
 * - requiredDependencies / resolved dependency decisions
 *
 * Rules:
 * - Selections are preferences, not deployment instructions.
 * - Match by metadataType + metadataName.
 * - Deploy → selected = true; Skip → selected = false.
 * - Only override when the item is editable.
 * - Never mutate action, required, destinationState, or other fields.
 * - Unknown / non-editable selections are ignored.
 *
 * Phase 2D/2E: Planner Decision Resolver uses per-type TRUST_POLICY and
 * produces an internal decision trace. While every type trusts nothing,
 * Deploy/Skip still uses editable only.
 *
 * Phase 4B: every selection builds an internal PlannerDecision first.
 * Runtime mutation still follows legacy editable logic; TRUST_POLICY empty
 * → useAnalyzer remains false. PlannerDecision is not returned via REST.
 *
 * Package Generation is unchanged: it still includes all selectedMetadata and
 * auto-includes dependencies where action === DEPLOY && selected === true.
 * Skipped primary metadata is removed from selectedMetadata before Package
 * Generation runs so existing package composition behaviour is preserved.
 */

const PLANNER_DECISION_OUTCOME = Object.freeze({
    APPLY: 'APPLY',
    IGNORE_MANDATORY: 'IGNORE_MANDATORY',
    IGNORE_UNKNOWN: 'IGNORE_UNKNOWN',
    IGNORE_NOT_SKIPPABLE: 'IGNORE_NOT_SKIPPABLE',
    NOOP: 'NOOP'
});

const PLANNER_CONFIDENCE = Object.freeze({
    HIGH: 'HIGH',
    MEDIUM: 'MEDIUM',
    LOW: 'LOW',
    NONE: 'NONE'
});

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function decisionKey(metadataType, metadataName) {
    return `${metadataType}:${metadataName}`;
}

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function buildItemIndex(items) {
    const index = new Map();

    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const metadataType = getItemType(item);
        const metadataName = getItemName(item);

        if (!metadataType || !metadataName) {
            continue;
        }

        const key = decisionKey(metadataType, metadataName);

        if (!index.has(key)) {
            index.set(key, i);
        }
    }

    return index;
}

function createEmptySummary(selectionsReceived) {
    return {
        selectionsReceived,
        overridesApplied: 0,
        overridesIgnored: 0,
        mandatoryIgnored: 0,
        unknownIgnored: 0
    };
}

/**
 * Per-metadata-type trust policy for analyzer-backed planner decisions.
 * Each type lists analysis levels the planner may trust for that type only.
 *
 * Phase 2D: every type trusts nothing → useAnalyzer always false.
 * Phase 2E can enable a single type, e.g. ApexClass: ['EXISTENCE'].
 */
const TRUST_POLICY = Object.freeze({
    ApexClass: Object.freeze([]),
    ApexTrigger: Object.freeze([]),
    CustomObject: Object.freeze([]),
    CustomField: Object.freeze([]),
    Layout: Object.freeze([]),
    Flow: Object.freeze([]),
    PermissionSet: Object.freeze([]),
    Profile: Object.freeze([])
});

function buildCompatibilityRowIndex(plannerCompatibilityReport) {
    const index = new Map();
    const results =
        plannerCompatibilityReport?.plannerCompatibility?.results ||
        plannerCompatibilityReport?.results ||
        [];

    if (!Array.isArray(results)) {
        return index;
    }

    for (const row of results) {
        const metadataType = row?.metadataType || null;
        const metadataName = row?.metadataName || null;

        if (!metadataType || !metadataName) {
            continue;
        }

        const key = decisionKey(metadataType, metadataName);

        if (!index.has(key)) {
            index.set(key, row);
        }
    }

    return index;
}

/**
 * Planner Decision Resolver.
 *
 * Owns migration policy: analyzer results vs legacy editable logic.
 * Trust is evaluated per metadata type via TRUST_POLICY.
 *
 * Phase 2E: returns an internal decision trace for diagnostics only.
 * Trace is not persisted, not returned via REST, and not logged by default.
 *
 * @param {object} params
 * @param {object} [params.metadataItem]
 * @param {object|null} [params.plannerCompatibilityRow]
 * @returns {{
 *   useAnalyzer: boolean,
 *   canSkip: boolean,
 *   trace: {
 *     metadataType: string|null,
 *     metadataName: string|null,
 *     analysisLevel: string,
 *     trustedLevels: string[],
 *     trustMatched: boolean,
 *     decisionPath: string,
 *     fallbackReason: string|null
 *   }
 * }}
 */
function resolvePlannerDecision({
    metadataItem,
    plannerCompatibilityRow
} = {}) {
    const metadataType =
        getItemType(metadataItem) ||
        plannerCompatibilityRow?.metadataType ||
        null;
    const metadataName =
        getItemName(metadataItem) ||
        plannerCompatibilityRow?.metadataName ||
        null;
    const analysisLevel =
        plannerCompatibilityRow?.analysisLevel || 'NONE';

    const trustedLevels = Array.isArray(TRUST_POLICY[metadataType])
        ? [...TRUST_POLICY[metadataType]]
        : [];

    const trustMatched = trustedLevels.includes(analysisLevel);

    if (trustMatched) {
        return {
            useAnalyzer: true,
            canSkip: plannerCompatibilityRow?.canSkip === true,
            trace: {
                metadataType,
                metadataName,
                analysisLevel,
                trustedLevels,
                trustMatched: true,
                decisionPath: 'ANALYZER',
                fallbackReason: null
            }
        };
    }

    return {
        useAnalyzer: false,
        canSkip: false,
        trace: {
            metadataType,
            metadataName,
            analysisLevel,
            trustedLevels,
            trustMatched: false,
            decisionPath: 'LEGACY_EDITABLE',
            fallbackReason:
                'Analysis level not trusted for metadata type.'
        }
    };
}

/**
 * Whether planner may override this item.
 * - Dependency decisions: editable must be === true (unchanged Phase 4.4B rule).
 * - Primary selectedMetadata: editable unless explicitly editable === false
 *   (primary inventory is user-planned; mandatory items opt out).
 */
function isPlannerEditable(item, collectionKind) {
    if (collectionKind === 'selectedMetadata') {
        return item?.editable !== false;
    }

    return item?.editable === true;
}

/**
 * Build an internal PlannerDecision for one selection hit.
 * Not returned via REST. Phase 4B infrastructure only — does not change
 * mutation behavior (legacy editable path still applies overrides).
 *
 * @param {object} params
 * @param {object|null} [params.metadataItem]
 * @param {object|null} [params.plannerCompatibilityRow]
 * @param {string|null} [params.choice]
 * @param {'selectedMetadata'|'requiredDependencies'|null} [params.collectionKind]
 * @param {boolean} [params.found]
 * @returns {object} PlannerDecision
 */
function buildPlannerDecision({
    metadataItem = null,
    plannerCompatibilityRow = null,
    choice = null,
    collectionKind = null,
    found = true
} = {}) {
    const resolved = resolvePlannerDecision({
        metadataItem,
        plannerCompatibilityRow
    });

    const metadataType =
        getItemType(metadataItem) ||
        plannerCompatibilityRow?.metadataType ||
        resolved.trace?.metadataType ||
        null;
    const metadataName =
        getItemName(metadataItem) ||
        plannerCompatibilityRow?.metadataName ||
        resolved.trace?.metadataName ||
        null;

    const analysisLevel = resolved.trace?.analysisLevel || 'NONE';
    const destinationState =
        metadataItem?.destinationState ||
        plannerCompatibilityRow?.destinationState ||
        null;

    const useAnalyzer = resolved.useAnalyzer === true;
    const canSkip = resolved.canSkip === true;
    const fallbackUsed = !useAnalyzer;
    const decisionPath =
        resolved.trace?.decisionPath || 'LEGACY_EDITABLE';

    const editable =
        found && metadataItem
            ? isPlannerEditable(metadataItem, collectionKind)
            : false;

    let allowOverride = false;
    let decision = PLANNER_DECISION_OUTCOME.IGNORE_UNKNOWN;
    let reason = 'Selection does not match selectedMetadata or resolvedDependencies.';
    let confidence = PLANNER_CONFIDENCE.NONE;

    if (!found) {
        allowOverride = false;
        decision = PLANNER_DECISION_OUTCOME.IGNORE_UNKNOWN;
        reason =
            'Selection does not match selectedMetadata or resolvedDependencies.';
        confidence = PLANNER_CONFIDENCE.NONE;
    } else if (useAnalyzer) {
        // Reserved analyzer path (unreachable while TRUST_POLICY is empty).
        // Mirror current empty stub: no selected mutation via analyzer yet.
        allowOverride = false;
        decision = PLANNER_DECISION_OUTCOME.IGNORE_NOT_SKIPPABLE;
        reason =
            'Analyzer path reserved; analyzer-backed override not implemented.';
        confidence = PLANNER_CONFIDENCE.LOW;
    } else if (!editable) {
        allowOverride = false;
        decision = PLANNER_DECISION_OUTCOME.IGNORE_MANDATORY;
        reason = 'Item is not planner-editable; selection ignored.';
        confidence = PLANNER_CONFIDENCE.HIGH;
    } else {
        // Legacy editable path — mutation still re-validates via applyChoice.
        allowOverride = true;
        decision = PLANNER_DECISION_OUTCOME.APPLY;
        reason = 'Legacy editable path; selection may update selected.';
        confidence = PLANNER_CONFIDENCE.HIGH;
    }

    return {
        metadataType,
        metadataName,
        choice,
        editable,
        canSkip,
        allowOverride,
        decision,
        reason,
        analysisLevel,
        confidence,
        destinationState,
        useAnalyzer,
        fallbackUsed,
        decisionPath,
        collectionKind,
        trace: resolved.trace
    };
}

/**
 * Apply one selection to a shallow-copied collection in place.
 * Returns whether an effective override was applied.
 * Legacy editable gate is re-checked here (unchanged Phase 4.4B behavior).
 */
function applyChoiceToIndexedItem({
    indexed,
    index,
    choice,
    collectionKind,
    summary,
    metadataType,
    metadataName
}) {
    const item = indexed[index];

    if (!isPlannerEditable(item, collectionKind)) {
        summary.mandatoryIgnored += 1;
        summary.overridesIgnored += 1;
        console.log(
            'Mandatory metadata ignored:',
            `${metadataType}:${metadataName}`
        );
        return false;
    }

    const nextSelected = choice === 'DEPLOY';
    const currentSelected = item.selected !== false;

    if (currentSelected === nextSelected) {
        return false;
    }

    indexed[index] = {
        ...item,
        selected: nextSelected
    };

    summary.overridesApplied += 1;
    console.log(
        'Overrides applied:',
        `${metadataType}:${metadataName}`,
        '→',
        choice,
        `(${collectionKind})`
    );

    return true;
}

/**
 * Apply Deployment Planner selections to primary metadata and dependency decisions.
 *
 * @param {object} params
 * @param {Array<object>} [params.selectedMetadata]
 * @param {Array<object>} [params.resolvedDependencies]
 * @param {Array<{ metadataType: string, metadataName: string, choice: 'DEPLOY'|'SKIP' }>} [params.deploymentSelections]
 * @param {object|null} [params.plannerCompatibilityReport]
 * @returns {{
 *   selectedMetadata: Array<object>,
 *   resolvedDependencies: Array<object>,
 *   summary: object
 * }}
 */
function applyPlannerOverrides({
    selectedMetadata = [],
    resolvedDependencies = [],
    deploymentSelections = [],
    plannerCompatibilityReport = null
} = {}) {
    const primary = Array.isArray(selectedMetadata) ? selectedMetadata : [];
    const dependencies = Array.isArray(resolvedDependencies)
        ? resolvedDependencies
        : [];
    const selections = Array.isArray(deploymentSelections)
        ? deploymentSelections
        : [];

    const summary = createEmptySummary(selections.length);
    const compatibilityRowIndex = buildCompatibilityRowIndex(
        plannerCompatibilityReport
    );
    // Phase 2E / 4B: internal diagnostics only — not returned, not persisted.
    const decisionTraces = [];
    const plannerDecisions = [];

    if (selections.length === 0) {
        return {
            selectedMetadata: primary,
            resolvedDependencies: dependencies,
            summary
        };
    }

    logSection('Deployment Planner');
    console.log('Planner selections received:', summary.selectionsReceived);

    const indexedPrimary = primary.map((item) => ({ ...item }));
    const indexedDependencies = dependencies.map((item) => ({ ...item }));
    const primaryIndex = buildItemIndex(indexedPrimary);
    const dependencyIndex = buildItemIndex(indexedDependencies);

    for (const selection of selections) {
        const metadataType = selection?.metadataType || null;
        const metadataName = selection?.metadataName || null;
        const choice = selection?.choice || null;

        if (!metadataType || !metadataName || !choice) {
            summary.overridesIgnored += 1;
            continue;
        }

        const key = decisionKey(metadataType, metadataName);
        const primaryPos = primaryIndex.get(key);
        const dependencyPos = dependencyIndex.get(key);
        const foundInPrimary = primaryPos !== undefined;
        const foundInDependencies = dependencyPos !== undefined;

        if (!foundInPrimary && !foundInDependencies) {
            const unknownDecision = buildPlannerDecision({
                metadataItem: { metadataType, metadataName },
                plannerCompatibilityRow:
                    compatibilityRowIndex.get(key) || null,
                choice,
                collectionKind: null,
                found: false
            });

            // PlannerDecision is recorded internally; traces stay unchanged
            // (unknown selections never contributed traces before Phase 4B).
            plannerDecisions.push(unknownDecision);

            summary.unknownIgnored += 1;
            summary.overridesIgnored += 1;
            console.log(
                'Overrides ignored (unknown):',
                `${metadataType}:${metadataName}`
            );
            continue;
        }

        const plannerCompatibilityRow =
            compatibilityRowIndex.get(key) || null;

        if (foundInPrimary) {
            const metadataItem = indexedPrimary[primaryPos];
            const plannerDecision = buildPlannerDecision({
                metadataItem,
                plannerCompatibilityRow,
                choice,
                collectionKind: 'selectedMetadata',
                found: true
            });

            plannerDecisions.push(plannerDecision);

            if (plannerDecision.trace) {
                decisionTraces.push(plannerDecision.trace);
            }

            // Phase 4B: PlannerDecision is built first; mutation still uses
            // legacy editable logic. TRUST_POLICY empty → useAnalyzer false.
            if (plannerDecision.useAnalyzer) {
                // Reserved for later analyzer-backed Deploy/Skip gating.
                // Unreachable while TRUST_POLICY lists are empty.
            } else {
                applyChoiceToIndexedItem({
                    indexed: indexedPrimary,
                    index: primaryPos,
                    choice,
                    collectionKind: 'selectedMetadata',
                    summary,
                    metadataType,
                    metadataName
                });
            }
        }

        if (foundInDependencies) {
            const metadataItem = indexedDependencies[dependencyPos];
            const plannerDecision = buildPlannerDecision({
                metadataItem,
                plannerCompatibilityRow,
                choice,
                collectionKind: 'requiredDependencies',
                found: true
            });

            plannerDecisions.push(plannerDecision);

            if (plannerDecision.trace) {
                decisionTraces.push(plannerDecision.trace);
            }

            if (plannerDecision.useAnalyzer) {
                // Reserved for later analyzer-backed Deploy/Skip gating.
                // Unreachable while TRUST_POLICY lists are empty.
            } else {
                applyChoiceToIndexedItem({
                    indexed: indexedDependencies,
                    index: dependencyPos,
                    choice,
                    collectionKind: 'requiredDependencies',
                    summary,
                    metadataType,
                    metadataName
                });
            }
        }
    }

    // Package Generation always includes selectedMetadata members. Remove
    // skipped primary items here so existing package composition is unchanged.
    const nextSelectedMetadata = indexedPrimary.filter(
        (item) => item.selected !== false
    );

    console.log('Overrides applied:', summary.overridesApplied);
    console.log('Overrides ignored:', summary.overridesIgnored);
    console.log('Mandatory metadata ignored:', summary.mandatoryIgnored);

    // Internal diagnostics only — intentionally not returned or exposed.
    void decisionTraces;
    void plannerDecisions;

    return {
        selectedMetadata: nextSelectedMetadata,
        resolvedDependencies: indexedDependencies,
        summary
    };
}

module.exports = {
    applyPlannerOverrides,
    // Exported for resolver / PlannerDecision verification only.
    resolvePlannerDecision,
    buildPlannerDecision,
    PLANNER_DECISION_OUTCOME,
    PLANNER_CONFIDENCE,
    TRUST_POLICY
};
