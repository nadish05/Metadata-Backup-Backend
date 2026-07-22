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
 * Phase 2D: Planner Decision Resolver uses per-type TRUST_POLICY.
 * While every type trusts nothing, Deploy/Skip still uses editable only.
 *
 * Package Generation is unchanged: it still includes all selectedMetadata and
 * auto-includes dependencies where action === DEPLOY && selected === true.
 * Skipped primary metadata is removed from selectedMetadata before Package
 * Generation runs so existing package composition behaviour is preserved.
 */

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
 * Phase 2D: all trust lists are empty → always useAnalyzer = false.
 *
 * @param {object} params
 * @param {object} [params.metadataItem]
 * @param {object|null} [params.plannerCompatibilityRow]
 * @returns {{ useAnalyzer: boolean, canSkip: boolean }}
 */
function resolvePlannerDecision({
    metadataItem,
    plannerCompatibilityRow
} = {}) {
    const metadataType =
        getItemType(metadataItem) ||
        plannerCompatibilityRow?.metadataType ||
        null;
    const analysisLevel =
        plannerCompatibilityRow?.analysisLevel || 'NONE';

    const trustedLevels = Array.isArray(TRUST_POLICY[metadataType])
        ? TRUST_POLICY[metadataType]
        : [];

    if (trustedLevels.includes(analysisLevel)) {
        return {
            useAnalyzer: true,
            canSkip: plannerCompatibilityRow?.canSkip === true
        };
    }

    return {
        useAnalyzer: false,
        canSkip: false
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
 * Apply one selection to a shallow-copied collection in place.
 * Returns whether an effective override was applied.
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
            const plannerDecision = resolvePlannerDecision({
                metadataItem,
                plannerCompatibilityRow
            });

            // Phase 2D: TRUST_POLICY lists are empty → useAnalyzer is false.
            // Legacy editable path via unchanged applyChoiceToIndexedItem.
            if (plannerDecision.useAnalyzer) {
                // Reserved for Phase 2E+: analyzer-backed Deploy/Skip gating
                // when a metadata type trusts EXISTENCE (or higher).
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
            const plannerDecision = resolvePlannerDecision({
                metadataItem,
                plannerCompatibilityRow
            });

            if (plannerDecision.useAnalyzer) {
                // Reserved for Phase 2E+: analyzer-backed Deploy/Skip gating
                // when a metadata type trusts EXISTENCE (or higher).
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

    return {
        selectedMetadata: nextSelectedMetadata,
        resolvedDependencies: indexedDependencies,
        summary
    };
}

module.exports = {
    applyPlannerOverrides,
    // Exported for resolver policy verification only.
    resolvePlannerDecision,
    TRUST_POLICY
};
