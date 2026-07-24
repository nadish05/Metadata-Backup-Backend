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
 * Phase 4C: execution is driven by PlannerDecision via executePlannerDecision
 * → Legacy Executor or Analyzer Executor (analyzer currently falls back to
 * legacy). TRUST_POLICY empty → useAnalyzer remains false → Legacy only.
 * Phase 4D: PlannerDecision.canSkip is computed (EXISTENCE capability only);
 * it does not authorize Skip while trust / analyzer executor remain disabled.
 * Phase 4E: Shadow Validation compares legacy editable vs analyzer canSkip
 * internally; analyzer never affects runtime mutation.
 * Phase 4F: PermissionSet trusts EXISTENCE; Analyzer Executor honors Skip when
 * EXISTS+canSkip, forces Deploy when MISSING, falls back on UNKNOWN.
 * Phase 5B: analyzer routing is TRUST_POLICY-driven (EXISTENCE trust → all
 * destination states); no metadata-type name checks in routing.
 * Phase 7C: Skip capability computed via authorizeCapabilities() (EXISTENCE
 * policy identical to computeCanSkip; GRAPH/CONTRACT/SEMANTIC passive).
 * Phase 7D: PlannerDecision gates consume authorization.authorized only —
 * no EXISTENCE / analysisLevel literals in Skip authorization decisions.
 * PlannerDecision is not returned via REST.
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

const {
    authorizeCapabilities
} = require('./plannerAuthorization.service');

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
 * Types that include EXISTENCE are routed to Analyzer Executor for all
 * destination states (EXISTS / MISSING / UNKNOWN). Phase 5B: routing is
 * TRUST_POLICY-driven only (no metadata-type name checks).
 */
const TRUST_POLICY = Object.freeze({
    ApexClass: Object.freeze([]),
    ApexTrigger: Object.freeze([]),
    CustomObject: Object.freeze([]),
    CustomField: Object.freeze([]),
    CustomLabel: Object.freeze(['EXISTENCE']),
    CustomMetadata: Object.freeze(['EXISTENCE']),
    Layout: Object.freeze([]),
    Flow: Object.freeze([]),
    NamedCredential: Object.freeze(['EXISTENCE']),
    PermissionSet: Object.freeze(['EXISTENCE']),
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
    const destinationState =
        metadataItem?.destinationState ||
        plannerCompatibilityRow?.destinationState ||
        null;

    const trustedLevels = Array.isArray(TRUST_POLICY[metadataType])
        ? [...TRUST_POLICY[metadataType]]
        : [];

    // Phase 7C: generic authorization helper (EXISTENCE-identical canSkip).
    const authorization = authorizeCapabilities({
        trustedCapabilities: trustedLevels,
        capabilities: plannerCompatibilityRow?.capabilities || null,
        destinationState,
        analysisLevel
    });
    const canSkip = authorization.canSkip;

    const trustMatched = trustedLevels.includes(analysisLevel);

    // Phase 7D: route Analyzer when any capabilities are trusted for the type
    // (current TRUST_POLICY entries are EXISTENCE-only → identical routing).
    const useAnalyzer = trustedLevels.length > 0;

    if (useAnalyzer) {
        return {
            useAnalyzer: true,
            canSkip,
            authorization,
            trace: {
                metadataType,
                metadataName,
                analysisLevel,
                trustedLevels,
                trustMatched: trustMatched === true,
                decisionPath: 'ANALYZER',
                fallbackReason: trustMatched
                    ? null
                    : 'Trusted capabilities configured; analyzer uses authorization + destination state.',
                authorizationTrace: authorization.trace
            }
        };
    }

    return {
        useAnalyzer: false,
        canSkip,
        authorization,
        trace: {
            metadataType,
            metadataName,
            analysisLevel,
            trustedLevels,
            trustMatched: false,
            decisionPath: 'LEGACY_EDITABLE',
            fallbackReason:
                'No trusted capabilities for metadata type.',
            authorizationTrace: authorization.trace
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
 * Phase 4E — Shadow Validation.
 * Compare legacy editable gate vs analyzer canSkip capability.
 * Diagnostics only — never drives mutation or REST.
 *
 * @param {object} params
 * @param {boolean} params.legacyEditable
 * @param {boolean} params.analyzerCanSkip
 * @returns {{
 *   legacyEditable: boolean,
 *   analyzerCanSkip: boolean,
 *   sameOutcome: boolean,
 *   differenceReason: string|null
 * }}
 */
function buildShadowValidation({
    legacyEditable = false,
    analyzerCanSkip = false
} = {}) {
    const legacy = legacyEditable === true;
    const analyzer = analyzerCanSkip === true;
    const sameOutcome = legacy === analyzer;

    let differenceReason = null;

    if (!sameOutcome) {
        if (legacy === true && analyzer === false) {
            differenceReason =
                'Analyzer determined metadata is not safe to skip.';
        } else if (legacy === false && analyzer === true) {
            differenceReason = 'Legacy marked metadata mandatory.';
        } else {
            differenceReason =
                'Legacy editable and analyzer canSkip disagree.';
        }
    }

    return {
        legacyEditable: legacy,
        analyzerCanSkip: analyzer,
        sameOutcome,
        differenceReason
    };
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
    // Phase 7C/7D: authorization helper is the single Skip policy source.
    const authorization =
        resolved.authorization ||
        authorizeCapabilities({
            trustedCapabilities: resolved.trace?.trustedLevels || [],
            capabilities: plannerCompatibilityRow?.capabilities || null,
            destinationState,
            analysisLevel
        });
    const canSkip = authorization.canSkip === true;
    const authorized = authorization.authorized === true;
    let fallbackUsed = !useAnalyzer;
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
        // Destination MISSING remains an inventory rule (force Deploy).
        // Skip honor/deny uses authorization.authorized only (Phase 7D).
        if (destinationState === 'MISSING') {
            allowOverride = true;
            decision = PLANNER_DECISION_OUTCOME.APPLY;
            reason =
                'Analyzer: destination MISSING; Deploy required.';
            confidence = PLANNER_CONFIDENCE.HIGH;
        } else if (authorized) {
            allowOverride = true;
            decision = PLANNER_DECISION_OUTCOME.APPLY;
            reason =
                'Analyzer: authorization granted; honor user Deploy/Skip.';
            confidence = PLANNER_CONFIDENCE.HIGH;
        } else {
            fallbackUsed = true;
            allowOverride = editable;
            decision = editable
                ? PLANNER_DECISION_OUTCOME.APPLY
                : PLANNER_DECISION_OUTCOME.IGNORE_MANDATORY;
            reason =
                'Analyzer authorization not granted; executor falls back to legacy.';
            confidence = PLANNER_CONFIDENCE.MEDIUM;
        }
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

    // Phase 4E: shadow compare legacy vs analyzer — never affects runtime.
    const shadowValidation = buildShadowValidation({
        legacyEditable: editable,
        analyzerCanSkip: canSkip
    });

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
        found,
        shadowValidation,
        // Phase 7C diagnostics — does not change decision outcomes.
        authorization,
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
 * Apply analyzer-authorized selected mutation (no legacy editable gate).
 * Used only by Analyzer Executor for trusted PermissionSet rules.
 */
function applyAnalyzerChoiceToIndexedItem({
    indexed,
    index,
    choice,
    summary,
    metadataType,
    metadataName,
    forceDeploy = false
}) {
    const item = indexed[index];
    const effectiveChoice = forceDeploy ? 'DEPLOY' : choice;
    const nextSelected = effectiveChoice === 'DEPLOY';
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
        'Overrides applied (analyzer):',
        `${metadataType}:${metadataName}`,
        '→',
        effectiveChoice,
        forceDeploy ? '(force Deploy)' : ''
    );

    return true;
}

/**
 * Legacy Executor — existing editable override path (unchanged logic).
 *
 * @param {object} plannerDecision
 * @param {object} context
 * @returns {boolean}
 */
function executeLegacyPlannerDecision(plannerDecision, context) {
    const {
        indexed,
        index,
        summary
    } = context;

    return applyChoiceToIndexedItem({
        indexed,
        index,
        choice: plannerDecision.choice,
        collectionKind: plannerDecision.collectionKind,
        summary,
        metadataType: plannerDecision.metadataType,
        metadataName: plannerDecision.metadataName
    });
}

/**
 * Analyzer Executor — Phase 4F PermissionSet EXISTENCE rules.
 *
 * - EXISTENCE + EXISTS + canSkip → honor user Deploy/Skip
 * - MISSING → force Deploy
 * - UNKNOWN / analyzer unavailable → Legacy fallback
 *
 * @param {object} plannerDecision
 * @param {object} context
 * @returns {boolean}
 */
function executeAnalyzerPlannerDecision(plannerDecision, context) {
    const analysisLevel = plannerDecision.analysisLevel;
    const destinationState = plannerDecision.destinationState;
    const canSkip = plannerDecision.canSkip === true;

    // MISSING takes precedence over analysisLevel NONE (inventory MISSING
    // still yields analyzer analysisLevel NONE today).
    if (destinationState === 'MISSING') {
        return applyAnalyzerChoiceToIndexedItem({
            indexed: context.indexed,
            index: context.index,
            choice: plannerDecision.choice,
            summary: context.summary,
            metadataType: plannerDecision.metadataType,
            metadataName: plannerDecision.metadataName,
            forceDeploy: true
        });
    }

    const analyzerUnavailable =
        analysisLevel === 'NONE' ||
        analysisLevel == null ||
        destinationState === 'UNKNOWN' ||
        destinationState == null;

    if (analyzerUnavailable) {
        return executeLegacyPlannerDecision(plannerDecision, context);
    }

    if (
        analysisLevel === 'EXISTENCE' &&
        destinationState === 'EXISTS' &&
        canSkip
    ) {
        return applyAnalyzerChoiceToIndexedItem({
            indexed: context.indexed,
            index: context.index,
            choice: plannerDecision.choice,
            summary: context.summary,
            metadataType: plannerDecision.metadataType,
            metadataName: plannerDecision.metadataName,
            forceDeploy: false
        });
    }

    return executeLegacyPlannerDecision(plannerDecision, context);
}

/**
 * Execute a PlannerDecision by routing to Analyzer or Legacy executor.
 *
 * @param {object} plannerDecision
 * @param {object} context
 * @returns {boolean}
 */
function executePlannerDecision(plannerDecision, context) {
    if (!plannerDecision || plannerDecision.found === false) {
        return false;
    }

    if (
        plannerDecision.decision === PLANNER_DECISION_OUTCOME.IGNORE_UNKNOWN
    ) {
        return false;
    }

    if (plannerDecision.useAnalyzer) {
        return executeAnalyzerPlannerDecision(plannerDecision, context);
    }

    return executeLegacyPlannerDecision(plannerDecision, context);
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
    // Phase 2E / 4B / 4E: internal diagnostics only — not returned, not persisted.
    const decisionTraces = [];
    const plannerDecisions = [];
    const shadowValidations = [];

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
            if (unknownDecision.shadowValidation) {
                shadowValidations.push(unknownDecision.shadowValidation);
            }

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

            if (plannerDecision.shadowValidation) {
                shadowValidations.push(plannerDecision.shadowValidation);
            }

            if (plannerDecision.trace) {
                decisionTraces.push(plannerDecision.trace);
            }

            // Phase 4C: PlannerDecision drives execution (Legacy while trust empty).
            executePlannerDecision(plannerDecision, {
                indexed: indexedPrimary,
                index: primaryPos,
                summary
            });
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

            if (plannerDecision.shadowValidation) {
                shadowValidations.push(plannerDecision.shadowValidation);
            }

            if (plannerDecision.trace) {
                decisionTraces.push(plannerDecision.trace);
            }

            executePlannerDecision(plannerDecision, {
                indexed: indexedDependencies,
                index: dependencyPos,
                summary
            });
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
    void shadowValidations;

    return {
        selectedMetadata: nextSelectedMetadata,
        resolvedDependencies: indexedDependencies,
        summary
    };
}

module.exports = {
    applyPlannerOverrides,
    // Exported for resolver / PlannerDecision / executor verification only.
    resolvePlannerDecision,
    buildPlannerDecision,
    buildShadowValidation,
    executePlannerDecision,
    executeLegacyPlannerDecision,
    executeAnalyzerPlannerDecision,
    PLANNER_DECISION_OUTCOME,
    PLANNER_CONFIDENCE,
    TRUST_POLICY,
    authorizeCapabilities
};
