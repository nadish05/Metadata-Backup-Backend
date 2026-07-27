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
 * Phase 7F: Analyzer Executor consumes PlannerDecision authorization —
 * no EXISTENCE / analysisLevel literals in execution gates.
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
    authorizeCapabilities,
    AUTHORIZATION_AVAILABILITY
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
    // Phase 8E — first production GRAPH trust (EXISTENCE AND GRAPH).
    CustomObject: Object.freeze(['EXISTENCE', 'GRAPH']),
    // Phase 9G — first production CONTRACT trust (EXISTENCE AND GRAPH AND CONTRACT).
    CustomField: Object.freeze(['EXISTENCE', 'GRAPH', 'CONTRACT']),
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

    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    console.log('\n==============================');
    console.log('DESTINATION STATE DEBUG');
    console.log('==============================');

    console.log('Metadata Type:', metadataType);
    console.log('Metadata Name:', metadataName);

    console.log(
        'metadataItem.destinationState:',
        metadataItem?.destinationState
    );

    console.log(
        'plannerCompatibilityRow.destinationState:',
        plannerCompatibilityRow?.destinationState
    );

    console.log(
        'Resolved destinationState:',
        destinationState
    );

    console.log(
        'plannerCompatibilityRow:',
        JSON.stringify(plannerCompatibilityRow, null, 2)
    );

    const useAnalyzer = resolved.useAnalyzer === true;
    const trustPolicy = resolved.trace?.trustedLevels || [];
    const editable =
        found && metadataItem
            ? isPlannerEditable(metadataItem, collectionKind)
            : false;

    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    console.log('\nPlanner Authorization Input');

    console.log({
        metadataType,
        metadataName,
        destinationState,
        useAnalyzer,
        editable,
        trustPolicy
    });

    // Phase 7C/7D: authorization helper is the single Skip policy source.
    const authorization =
        resolved.authorization ||
        authorizeCapabilities({
            trustedCapabilities: trustPolicy,
            capabilities: plannerCompatibilityRow?.capabilities || null,
            destinationState,
            analysisLevel
        });
    const canSkip = authorization.canSkip === true;
    const authorized = authorization.authorized === true;
    let fallbackUsed = !useAnalyzer;
    const decisionPath =
        resolved.trace?.decisionPath || 'LEGACY_EDITABLE';

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
                'Analyzer: authorization GRANTED; honor user Deploy/Skip.';
            confidence = PLANNER_CONFIDENCE.HIGH;
        } else {
            // Phase 8F: authorization DENIED — enforce Deploy; no Legacy fallback.
            fallbackUsed = false;
            allowOverride = true;
            decision = PLANNER_DECISION_OUTCOME.APPLY;
            reason =
                'Analyzer: authorization DENIED; Deploy required (Skip not authorized).';
            confidence = PLANNER_CONFIDENCE.HIGH;
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

    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    console.log('\nApply Choice');

    console.log({
        metadataType,
        metadataName,
        choice,
        beforeSelected: item.selected
    });

    if (!isPlannerEditable(item, collectionKind)) {
        summary.mandatoryIgnored += 1;
        summary.overridesIgnored += 1;
        console.log(
            'Mandatory metadata ignored:',
            `${metadataType}:${metadataName}`
        );
        // TEMPORARY DEBUG — remove after Skip destinationState investigation.
        console.log({
            afterSelected: item.selected,
            overrideApplied: item.selected === false
        });
        return false;
    }

    const nextSelected = choice === 'DEPLOY';
    const currentSelected = item.selected !== false;

    if (currentSelected === nextSelected) {
        // TEMPORARY DEBUG — remove after Skip destinationState investigation.
        console.log({
            afterSelected: item.selected,
            overrideApplied: item.selected === false
        });
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

    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    console.log({
        afterSelected: indexed[index].selected,
        overrideApplied: indexed[index].selected === false
    });

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

    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    // CustomField analyzer path uses this mutator (not applyChoiceToIndexedItem).
    console.log('\nApply Choice');

    console.log({
        metadataType,
        metadataName,
        choice: effectiveChoice,
        beforeSelected: item.selected
    });

    if (currentSelected === nextSelected) {
        // TEMPORARY DEBUG — remove after Skip destinationState investigation.
        console.log({
            afterSelected: item.selected,
            overrideApplied: item.selected === false
        });
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

    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    console.log({
        afterSelected: indexed[index].selected,
        overrideApplied: indexed[index].selected === false
    });

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
 * Analyzer Executor — Phase 7F / 8F authorization-aligned execution.
 *
 * Trusts PlannerDecision as the source of truth:
 * - destination MISSING → force Deploy (inventory enforcement)
 * - authorization GRANTED → honor user Deploy/Skip
 * - authorization DENIED → force Deploy (no Legacy fallback)
 * - authorization UNAVAILABLE → Legacy Executor
 *
 * Does not inspect analysisLevel, EXISTENCE, graphSafe, or capability maps.
 *
 * @param {object} plannerDecision
 * @param {object} context
 * @returns {boolean}
 */
function executeAnalyzerPlannerDecision(plannerDecision, context) {
    const destinationState = plannerDecision.destinationState;
    const authorization = plannerDecision.authorization || null;
    const authorized = authorization?.authorized === true;
    const availability = authorization?.availability || null;

    // Inventory enforcement (planner MISSING rule applied at execute time
    // so user Skip cannot omit a missing dependency).
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

    // Phase 8F — UNAVAILABLE may still use Legacy Executor.
    if (availability === AUTHORIZATION_AVAILABILITY.UNAVAILABLE) {
        return executeLegacyPlannerDecision(plannerDecision, context);
    }

    // Phase 8F — GRANTED honors user Deploy/Skip.
    if (
        availability === AUTHORIZATION_AVAILABILITY.GRANTED ||
        (authorized && availability !== AUTHORIZATION_AVAILABILITY.DENIED)
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

    // Phase 8F — DENIED (or authorized=false on analyzer path): enforce Deploy.
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

            // TEMPORARY DEBUG — remove after Skip destinationState investigation.
            console.log('\nPlanner Decision');

            console.log({
                metadataType: plannerDecision.metadataType,
                metadataName: plannerDecision.metadataName,
                decision: plannerDecision.decision,
                allowOverride: plannerDecision.allowOverride,
                editable: plannerDecision.editable
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

            // TEMPORARY DEBUG — remove after Skip destinationState investigation.
            console.log('\nPlanner Decision');

            console.log({
                metadataType: plannerDecision.metadataType,
                metadataName: plannerDecision.metadataName,
                decision: plannerDecision.decision,
                allowOverride: plannerDecision.allowOverride,
                editable: plannerDecision.editable
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
