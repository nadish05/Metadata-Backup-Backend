/**
 * AI Semantic Advisor — Context Builder (Phase 10B).
 *
 * Deterministic transformation of in-memory planner structures into a
 * versioned JSON context for a future LLM.
 *
 * Does NOT call any model, change planner decisions, or re-query Salesforce.
 */

const {
    AI_CONTEXT_SCHEMA_VERSION,
    AI_CONTEXT_VERSION,
    AI_PLANNER_VERSION,
    DEFAULT_MAX_ITEMS,
    MAX_REASON_LENGTH,
    MAX_MISMATCHES,
    MAX_BLOCKING_DEPENDS_ON,
    MAX_RISK_INDICATORS,
    MAX_COMPONENT_NAME_SAMPLES,
    SECRET_KEY_PATTERN,
    FORBIDDEN_PAYLOAD_KEYS,
    DEFAULT_CONSTRAINTS,
    RISK_INDICATORS,
    validateAiContext
} = require('./aiContext.schema');

/**
 * Build AI context from in-memory planner / package objects.
 *
 * @param {object} [params]
 * @param {object[]} [params.plannerDecisions]
 * @param {object|null} [params.plannerCompatibility]
 * @param {object|null} [params.generatedDeploymentPackage]
 * @param {object|null} [params.deploymentSummary]
 * @param {object|null} [params.request]
 * @param {object} [params.options]
 * @returns {{
 *   context: object|null,
 *   validation: { valid: boolean, errors: string[] }
 * }}
 */
function buildAiContext({
    plannerDecisions = [],
    plannerCompatibility = null,
    generatedDeploymentPackage = null,
    deploymentSummary = null,
    request = null,
    options = {}
} = {}) {
    const maxItems =
        Number.isInteger(options.maxItems) && options.maxItems > 0
            ? options.maxItems
            : DEFAULT_MAX_ITEMS;

    const generatedAt =
        typeof options.generatedAt === 'string' && options.generatedAt
            ? options.generatedAt
            : null;

    const plannerVersion =
        typeof options.plannerVersion === 'string' && options.plannerVersion
            ? options.plannerVersion
            : AI_PLANNER_VERSION;

    try {
        const compatibilityResults = extractCompatibilityResults(
            plannerCompatibility
        );
        const compatibilityByKey = indexByMetadataKey(compatibilityResults);
        const decisions = Array.isArray(plannerDecisions)
            ? plannerDecisions.filter((entry) => entry && typeof entry === 'object')
            : [];

        const itemKeys = collectItemKeys(decisions, compatibilityResults);
        const truncatedKeys = itemKeys.slice(0, maxItems);
        const truncated = itemKeys.length > maxItems;

        const items = truncatedKeys.map((key) =>
            buildItem({
                key,
                decision: findDecision(decisions, key),
                compatibilityRow: compatibilityByKey.get(key) || null
            })
        );

        const packageSection = buildPackageSection(generatedDeploymentPackage);
        const summary = buildSummary({
            items,
            decisions,
            compatibilityResults,
            packageSection,
            deploymentSummary,
            truncated,
            totalCandidates: itemKeys.length
        });

        const context = {
            schemaVersion: AI_CONTEXT_SCHEMA_VERSION,
            request: buildRequestSection(request),
            summary,
            items,
            package: packageSection,
            constraints: { ...DEFAULT_CONSTRAINTS },
            advisorMetadata: buildAdvisorMetadata({
                generatedAt,
                plannerVersion,
                itemCount: items.length,
                truncated,
                totalCandidates: itemKeys.length
            })
        };

        // Fill contextSize after serialization for a stable byte measure.
        const serialized = stableStringify(context);
        context.advisorMetadata.contextSize = Buffer.byteLength(
            serialized,
            'utf8'
        );

        const validation = validateAiContext(context, { maxItems });

        return {
            context,
            validation
        };
    } catch (error) {
        return {
            context: null,
            validation: {
                valid: false,
                errors: [
                    `Context construction failed: ${error?.message || String(error)}`
                ]
            }
        };
    }
}

function extractCompatibilityResults(plannerCompatibility) {
    if (!plannerCompatibility || typeof plannerCompatibility !== 'object') {
        return [];
    }

    const results =
        plannerCompatibility.plannerCompatibility?.results ||
        plannerCompatibility.results ||
        [];

    return Array.isArray(results) ? results.filter(Boolean) : [];
}

function metadataKey(metadataType, metadataName) {
    return `${metadataType || ''}::${metadataName || ''}`;
}

function indexByMetadataKey(rows) {
    const map = new Map();

    for (const row of rows) {
        const type = row?.metadataType || null;
        const name = row?.metadataName || null;

        if (!type || !name) {
            continue;
        }

        const key = metadataKey(type, name);

        if (!map.has(key)) {
            map.set(key, row);
        }
    }

    return map;
}

function collectItemKeys(decisions, compatibilityResults) {
    const keys = new Set();

    for (const decision of decisions) {
        const type = decision?.metadataType || null;
        const name = decision?.metadataName || null;

        if (type && name) {
            keys.add(metadataKey(type, name));
        }
    }

    for (const row of compatibilityResults) {
        const type = row?.metadataType || null;
        const name = row?.metadataName || null;

        if (type && name) {
            keys.add(metadataKey(type, name));
        }
    }

    return [...keys].sort((a, b) => a.localeCompare(b));
}

function findDecision(decisions, key) {
    for (const decision of decisions) {
        if (
            metadataKey(decision?.metadataType, decision?.metadataName) === key
        ) {
            return decision;
        }
    }

    return null;
}

function buildItem({ key, decision, compatibilityRow }) {
    const [metadataType, metadataName] = splitKey(key);
    const capabilitiesSource =
        decision?.authorization?.trace?.evaluated &&
        compatibilityRow?.capabilities
            ? compatibilityRow.capabilities
            : compatibilityRow?.capabilities || null;

    const capabilities = sanitizeCapabilities(
        capabilitiesSource || deriveCapabilitiesFromDecision(decision)
    );

    const authorization = sanitizeAuthorization(
        decision?.authorization || null,
        compatibilityRow
    );

    const planner = buildPlannerSlice({
        decision,
        compatibilityRow,
        authorization
    });

    return {
        metadataType,
        metadataName,
        planner,
        authorization,
        capabilities,
        graph: buildGraphSummary(compatibilityRow, capabilities),
        contract: buildContractSummary(capabilities),
        confidence: planner.confidence,
        reason: truncateReason(planner.reason)
    };
}

function splitKey(key) {
    const separator = key.indexOf('::');

    if (separator < 0) {
        return [key, null];
    }

    return [key.slice(0, separator), key.slice(separator + 2)];
}

function buildPlannerSlice({ decision, compatibilityRow, authorization }) {
    const destinationState =
        decision?.destinationState ||
        compatibilityRow?.capabilities?.EXISTENCE?.evidence?.destinationState ||
        null;

    const authorized =
        authorization?.authorized === true ||
        decision?.authorization?.authorized === true;

    const choice =
        decision?.choice ||
        null;

    let effectiveDecision = null;

    if (choice === 'SKIP' || choice === 'DEPLOY') {
        effectiveDecision = choice;
    } else if (authorized === true && destinationState === 'EXISTS') {
        effectiveDecision = 'SkipEligible';
    } else if (destinationState === 'MISSING') {
        effectiveDecision = 'Deploy';
    } else if (authorization?.availability === 'DENIED') {
        effectiveDecision = 'Deploy';
    }

    return {
        choice,
        decision: decision?.decision || null,
        effectiveDecision,
        canSkip:
            decision?.canSkip === true ||
            compatibilityRow?.canSkip === true ||
            false,
        authorized,
        availability: authorization?.availability || null,
        destinationState,
        useAnalyzer: decision?.useAnalyzer === true,
        fallbackUsed: decision?.fallbackUsed === true,
        confidence: decision?.confidence || null,
        reason: truncateReason(
            decision?.reason || compatibilityRow?.reason || null
        ),
        analysisLevel:
            decision?.analysisLevel ||
            compatibilityRow?.analysisLevel ||
            null,
        decisionPath: decision?.decisionPath || null,
        editable: decision?.editable === true
    };
}

function sanitizeAuthorization(authorization) {
    if (!authorization || typeof authorization !== 'object') {
        return {
            authorized: false,
            availability: null,
            reasons: [],
            evaluated: []
        };
    }

    const evaluated = Array.isArray(authorization.trace?.evaluated)
        ? authorization.trace.evaluated.map((entry) => ({
              capability: entry?.capability || null,
              role: entry?.role || null,
              status: entry?.status || null,
              trusted: entry?.trusted === true,
              contributedToCanSkip: entry?.contributedToCanSkip === true
          }))
        : [];

    return {
        authorized: authorization.authorized === true,
        availability: authorization.availability || null,
        reasons: sanitizeStringArray(authorization.reasons),
        evaluated: sortByCapability(evaluated)
    };
}

function deriveCapabilitiesFromDecision(decision) {
    if (!decision?.authorization?.trace?.evaluated) {
        return null;
    }

    const derived = {};

    for (const entry of decision.authorization.trace.evaluated) {
        if (!entry?.capability) {
            continue;
        }

        derived[entry.capability] = {
            status: entry.status || null,
            reason: null,
            evidence: {}
        };
    }

    return derived;
}

function sanitizeCapabilities(capabilities) {
    if (!capabilities || typeof capabilities !== 'object') {
        return {};
    }

    const sanitized = {};
    const ids = Object.keys(capabilities).sort((a, b) => a.localeCompare(b));

    for (const capabilityId of ids) {
        const entry = capabilities[capabilityId];

        if (!entry || typeof entry !== 'object') {
            continue;
        }

        sanitized[capabilityId] = {
            status: entry.status || null,
            reason: truncateReason(entry.reason || null),
            evidence: sanitizeEvidence(capabilityId, entry.evidence || {})
        };
    }

    return sanitized;
}

function sanitizeEvidence(capabilityId, evidence) {
    if (!evidence || typeof evidence !== 'object') {
        return {};
    }

    if (capabilityId === 'EXISTENCE') {
        return pickAllowed(evidence, [
            'destinationState',
            'existsInDestination'
        ]);
    }

    if (capabilityId === 'GRAPH') {
        const graph = pickAllowed(evidence, [
            'graphSafe',
            'graphEvaluationStatus',
            'dependsOnSatisfied',
            'truncated',
            'unresolvedCount'
        ]);

        if (Array.isArray(evidence.blockingDependsOn)) {
            graph.blockingDependsOn = evidence.blockingDependsOn
                .slice(0, MAX_BLOCKING_DEPENDS_ON)
                .map((edge) => sanitizeGraphEdge(edge))
                .filter(Boolean);
        }

        if (Array.isArray(evidence.dependsOnChecked)) {
            graph.dependsOnCheckedCount = evidence.dependsOnChecked.length;
        }

        return graph;
    }

    if (capabilityId === 'CONTRACT') {
        const contract = pickAllowed(evidence, ['existsInDestination']);

        if (Array.isArray(evidence.rulesChecked)) {
            contract.rulesChecked = [...evidence.rulesChecked]
                .map(String)
                .sort((a, b) => a.localeCompare(b));
        }

        if (Array.isArray(evidence.mismatches)) {
            contract.mismatches = evidence.mismatches
                .slice(0, MAX_MISMATCHES)
                .map((mismatch) => sanitizeMismatch(mismatch))
                .filter(Boolean);
        }

        if (evidence.sourceSummary && typeof evidence.sourceSummary === 'object') {
            contract.sourceSummary = sanitizeAttributeSummary(
                evidence.sourceSummary
            );
        }

        if (
            evidence.destinationSummary &&
            typeof evidence.destinationSummary === 'object'
        ) {
            contract.destinationSummary = sanitizeAttributeSummary(
                evidence.destinationSummary
            );
        }

        return contract;
    }

    // SEMANTIC / unknown — empty evidence only.
    return {};
}

function sanitizeGraphEdge(edge) {
    if (!edge || typeof edge !== 'object') {
        if (typeof edge === 'string') {
            return { name: edge };
        }

        return null;
    }

    return pickAllowed(edge, [
        'type',
        'name',
        'metadataType',
        'metadataName',
        'status',
        'reason'
    ]);
}

function sanitizeMismatch(mismatch) {
    if (!mismatch || typeof mismatch !== 'object') {
        return null;
    }

    return {
        ruleId: mismatch.ruleId || mismatch.id || null,
        field: mismatch.field || mismatch.attribute || null,
        message: truncateReason(mismatch.message || mismatch.reason || null),
        sourceValue: sanitizePrimitive(mismatch.sourceValue),
        destinationValue: sanitizePrimitive(mismatch.destinationValue)
    };
}

function sanitizeAttributeSummary(summary) {
    const allowed = [
        'type',
        'length',
        'precision',
        'scale',
        'required',
        'unique',
        'externalId',
        'referenceTo',
        'label',
        'calculated',
        'custom'
    ];

    return pickAllowed(summary, allowed);
}

function sanitizePrimitive(value) {
    if (
        value == null ||
        typeof value === 'boolean' ||
        typeof value === 'number'
    ) {
        return value;
    }

    if (typeof value === 'string') {
        return truncateReason(value);
    }

    if (Array.isArray(value)) {
        return value
            .slice(0, 10)
            .map((entry) => sanitizePrimitive(entry))
            .filter((entry) => entry !== undefined);
    }

    return undefined;
}

function buildGraphSummary(compatibilityRow, capabilities) {
    const graphCapability = capabilities?.GRAPH || null;
    const evidence = graphCapability?.evidence || {};

    return {
        status: graphCapability?.status || null,
        graphSafe:
            compatibilityRow?.graphSafe === true ||
            evidence.graphSafe === true ||
            false,
        reason: truncateReason(
            compatibilityRow?.graphReasons?.[0] ||
                graphCapability?.reason ||
                null
        ),
        blockingDependsOn: Array.isArray(evidence.blockingDependsOn)
            ? evidence.blockingDependsOn
            : [],
        unresolvedCount:
            typeof evidence.unresolvedCount === 'number'
                ? evidence.unresolvedCount
                : null
    };
}

function buildContractSummary(capabilities) {
    const contractCapability = capabilities?.CONTRACT || null;
    const evidence = contractCapability?.evidence || {};

    return {
        status: contractCapability?.status || null,
        reason: truncateReason(contractCapability?.reason || null),
        rulesChecked: Array.isArray(evidence.rulesChecked)
            ? evidence.rulesChecked
            : [],
        mismatchCount: Array.isArray(evidence.mismatches)
            ? evidence.mismatches.length
            : 0,
        mismatches: Array.isArray(evidence.mismatches)
            ? evidence.mismatches
            : []
    };
}

function buildPackageSection(generatedDeploymentPackage) {
    const pkg =
        generatedDeploymentPackage &&
        typeof generatedDeploymentPackage === 'object'
            ? generatedDeploymentPackage
            : {};

    const summary =
        pkg.summary && typeof pkg.summary === 'object'
            ? {
                  metadataCount: numberOrZero(pkg.summary.metadataCount),
                  dependencyCount: numberOrZero(pkg.summary.dependencyCount),
                  testClassCount: numberOrZero(pkg.summary.testClassCount),
                  totalComponents: numberOrZero(pkg.summary.totalComponents)
              }
            : {
                  metadataCount: Array.isArray(pkg.metadata)
                      ? pkg.metadata.length
                      : 0,
                  dependencyCount: Array.isArray(pkg.dependencies)
                      ? pkg.dependencies.length
                      : 0,
                  testClassCount: Array.isArray(pkg.testClasses)
                      ? pkg.testClasses.length
                      : 0,
                  totalComponents: 0
              };

    if (!pkg.summary) {
        summary.totalComponents =
            summary.metadataCount + summary.dependencyCount;
    }

    const metadataTypes = new Set();
    const componentNamesSample = [];

    for (const item of [
        ...(Array.isArray(pkg.metadata) ? pkg.metadata : []),
        ...(Array.isArray(pkg.dependencies) ? pkg.dependencies : [])
    ]) {
        const type = item?.metadataType || item?.type || null;
        const name = item?.metadataName || item?.name || null;

        if (type) {
            metadataTypes.add(type);
        }

        if (type && name && componentNamesSample.length < MAX_COMPONENT_NAME_SAMPLES) {
            componentNamesSample.push(`${type}:${name}`);
        }
    }

    return {
        summary,
        metadataTypes: [...metadataTypes].sort((a, b) => a.localeCompare(b)),
        componentNamesSample: componentNamesSample.sort((a, b) =>
            a.localeCompare(b)
        )
    };
}

function buildSummary({
    items,
    decisions,
    compatibilityResults,
    packageSection,
    deploymentSummary,
    truncated,
    totalCandidates
}) {
    const planner = {
        decisionCount: decisions.length,
        compatibilityRowCount: compatibilityResults.length,
        itemCount: items.length,
        truncated: truncated === true,
        totalCandidates,
        skipEligible: 0,
        deployRequired: 0,
        authorizedTrue: 0,
        authorizedFalse: 0,
        fallbackUsed: 0,
        useAnalyzer: 0
    };

    const capabilities = {
        existencePass: 0,
        existenceFail: 0,
        existenceUnknown: 0,
        graphPass: 0,
        graphFail: 0,
        graphUnknown: 0,
        contractPass: 0,
        contractFail: 0,
        contractUnknown: 0,
        semanticNotEvaluated: 0
    };

    const authorization = {
        granted: 0,
        denied: 0,
        unavailable: 0
    };

    const riskSet = new Set();

    for (const item of items) {
        if (item.planner?.canSkip) {
            planner.skipEligible += 1;
        } else {
            planner.deployRequired += 1;
        }

        if (item.planner?.authorized) {
            planner.authorizedTrue += 1;
        } else {
            planner.authorizedFalse += 1;
        }

        if (item.planner?.fallbackUsed) {
            planner.fallbackUsed += 1;
            riskSet.add(RISK_INDICATORS.FALLBACK_USED);
        }

        if (item.planner?.useAnalyzer) {
            planner.useAnalyzer += 1;
        }

        tallyCapability(capabilities, riskSet, item.capabilities?.EXISTENCE, 'existence');
        tallyCapability(capabilities, riskSet, item.capabilities?.GRAPH, 'graph');
        tallyCapability(capabilities, riskSet, item.capabilities?.CONTRACT, 'contract');

        if (item.capabilities?.SEMANTIC?.status === 'NOT_EVALUATED') {
            capabilities.semanticNotEvaluated += 1;
        }

        if (item.graph?.graphSafe === false) {
            riskSet.add(RISK_INDICATORS.GRAPH_BLOCKED);
        }

        const availability = item.authorization?.availability;
        if (availability === 'GRANTED') {
            authorization.granted += 1;
        } else if (availability === 'DENIED') {
            authorization.denied += 1;
            riskSet.add(RISK_INDICATORS.AUTHORIZATION_DENIED);
        } else if (availability === 'UNAVAILABLE') {
            authorization.unavailable += 1;
            riskSet.add(RISK_INDICATORS.AUTHORIZATION_UNAVAILABLE);
        }

        if (item.planner?.destinationState === 'UNKNOWN') {
            riskSet.add(RISK_INDICATORS.UNKNOWN_DESTINATION);
        }

        if (item.planner?.destinationState === 'MISSING') {
            riskSet.add(RISK_INDICATORS.MISSING_DESTINATION);
        }
    }

    if (deploymentSummary && typeof deploymentSummary === 'object') {
        planner.deployCount = numberOrZero(deploymentSummary.deployCount);
        planner.skipCount = numberOrZero(deploymentSummary.skipCount);
        planner.ignoredCount = numberOrZero(deploymentSummary.ignoredCount);
    }

    return {
        planner,
        capabilities,
        authorization,
        package: { ...packageSection.summary },
        riskIndicators: [...riskSet]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, MAX_RISK_INDICATORS)
    };
}

function tallyCapability(capabilities, riskSet, entry, prefix) {
    const status = entry?.status || null;

    if (status === 'PASS') {
        capabilities[`${prefix}Pass`] += 1;
    } else if (status === 'FAIL') {
        capabilities[`${prefix}Fail`] += 1;
        if (prefix === 'existence') {
            riskSet.add(RISK_INDICATORS.EXISTENCE_FAIL);
        } else if (prefix === 'graph') {
            riskSet.add(RISK_INDICATORS.GRAPH_FAIL);
        } else if (prefix === 'contract') {
            riskSet.add(RISK_INDICATORS.CONTRACT_FAIL);
        }
    } else if (
        status === 'UNKNOWN' ||
        status === 'DEFERRED' ||
        status === 'NOT_EVALUATED'
    ) {
        capabilities[`${prefix}Unknown`] += 1;
        if (prefix === 'existence') {
            riskSet.add(RISK_INDICATORS.EXISTENCE_UNKNOWN);
        } else if (prefix === 'graph') {
            riskSet.add(RISK_INDICATORS.GRAPH_UNKNOWN);
        } else if (prefix === 'contract') {
            riskSet.add(RISK_INDICATORS.CONTRACT_UNKNOWN);
        }
    }
}

function buildRequestSection(request) {
    const source = request && typeof request === 'object' ? request : {};

    return {
        validationId:
            typeof source.validationId === 'string' ? source.validationId : null,
        mode: typeof source.mode === 'string' ? source.mode : null
    };
}

function buildAdvisorMetadata({
    generatedAt,
    plannerVersion,
    itemCount,
    truncated,
    totalCandidates
}) {
    return {
        generatedAt,
        plannerVersion,
        contextVersion: AI_CONTEXT_VERSION,
        schemaVersion: AI_CONTEXT_SCHEMA_VERSION,
        contextSize: 0,
        itemCount,
        truncated: truncated === true,
        totalCandidates,
        aiGenerated: false
    };
}

function pickAllowed(source, allowedKeys) {
    const result = {};

    for (const key of allowedKeys) {
        if (
            Object.prototype.hasOwnProperty.call(source, key) &&
            !SECRET_KEY_PATTERN.test(key) &&
            !FORBIDDEN_PAYLOAD_KEYS.includes(key)
        ) {
            const value = source[key];

            if (
                value == null ||
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            ) {
                result[key] =
                    typeof value === 'string' ? truncateReason(value) : value;
            } else if (Array.isArray(value) && value.every(isPrimitive)) {
                result[key] = value.slice(0, 20).map((entry) =>
                    typeof entry === 'string' ? truncateReason(entry) : entry
                );
            }
        }
    }

    return result;
}

function isPrimitive(value) {
    return (
        value == null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    );
}

function truncateReason(value) {
    if (value == null) {
        return null;
    }

    const text = String(value);

    if (text.length <= MAX_REASON_LENGTH) {
        return text;
    }

    return `${text.slice(0, MAX_REASON_LENGTH)}…`;
}

function sanitizeStringArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }

    return values
        .filter((entry) => typeof entry === 'string')
        .map((entry) => truncateReason(entry))
        .slice(0, 40);
}

function sortByCapability(evaluated) {
    return [...evaluated].sort((a, b) =>
        String(a.capability || '').localeCompare(String(b.capability || ''))
    );
}

function numberOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Deterministic JSON stringify (sorted object keys).
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
    return JSON.stringify(sortValue(value));
}

function sortValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortValue);
    }

    if (value && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
            sorted[key] = sortValue(value[key]);
        }
        return sorted;
    }

    return value;
}

/**
 * Deep-sanitize a plain object by stripping forbidden / secret-like keys.
 * Used by tests / callers that need an extra pass.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function stripSecrets(value) {
    if (Array.isArray(value)) {
        return value.map(stripSecrets);
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    const result = {};

    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_PAYLOAD_KEYS.includes(key) || SECRET_KEY_PATTERN.test(key)) {
            continue;
        }

        result[key] = stripSecrets(child);
    }

    return result;
}

module.exports = {
    buildAiContext,
    validateAiContext,
    stableStringify,
    stripSecrets,
    AI_CONTEXT_SCHEMA_VERSION,
    AI_CONTEXT_VERSION,
    DEFAULT_MAX_ITEMS,
    DEFAULT_CONSTRAINTS,
    RISK_INDICATORS
};
