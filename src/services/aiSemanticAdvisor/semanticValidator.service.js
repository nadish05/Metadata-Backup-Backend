/**
 * AI Semantic Advisor — Semantic Validator (Phase 10D).
 *
 * Grounds raw semantic responses against validated AI Context facts.
 * Does not call Salesforce, touch the planner, or modify prompts.
 */

const { validateAiContext } = require('./aiContext.schema');
const {
    validateSemanticResponse,
    createEmptySemanticResponse
} = require('./semanticResponse.schema');
const {
    SEMANTIC_VALIDATION_SCHEMA_VERSION,
    VALIDATION_ADVISOR_STATUS,
    VALIDATABLE_SECTIONS,
    STRING_SECTIONS,
    ARRAY_STRING_SECTIONS,
    CAPABILITY_IDS,
    CAPABILITY_STATUSES,
    UNSAFE_ADVICE_PATTERNS,
    DECISION_OVERRIDE_PATTERNS
} = require('./semanticValidation.schema');

/**
 * Validate and ground a raw semantic response against planner context.
 *
 * @param {object|null} validatedContext
 * @param {object|null} rawSemanticResponse
 * @returns {{
 *   advisorStatus: string,
 *   validation: object,
 *   groundedSemanticResponse: object|null
 * }}
 */
function validateSemanticGrounding(validatedContext, rawSemanticResponse) {
    const contextCheck = validateAiContext(validatedContext);

    if (!contextCheck.valid) {
        return buildUnavailable(
            `Validated context is required for grounding: ${contextCheck.errors.join('; ')}`
        );
    }

    if (rawSemanticResponse == null) {
        return buildUnavailable('Raw semantic response is null.');
    }

    const schemaCheck = validateSemanticResponse(rawSemanticResponse);

    if (!schemaCheck.valid || !schemaCheck.normalized) {
        return {
            advisorStatus: VALIDATION_ADVISOR_STATUS.INVALID_RESPONSE,
            validation: {
                schemaVersion: SEMANTIC_VALIDATION_SCHEMA_VERSION,
                validatedSections: [],
                removedSections: [...VALIDATABLE_SECTIONS],
                validationWarnings: schemaCheck.errors.slice(),
                groundingScore: 0,
                errors: schemaCheck.errors.slice()
            },
            groundedSemanticResponse: null
        };
    }

    const normalized = schemaCheck.normalized;
    const factIndex = buildFactIndex(validatedContext);
    const validatedSections = [];
    const removedSections = [];
    const validationWarnings = [];
    const grounded = createEmptySemanticResponse();

    for (const section of VALIDATABLE_SECTIONS) {
        const sectionResult = validateSection(
            section,
            normalized[section],
            factIndex,
            validatedContext
        );

        if (sectionResult.valid) {
            grounded[section] = sectionResult.value;
            validatedSections.push(section);

            for (const warning of sectionResult.warnings || []) {
                validationWarnings.push(`${section}: ${warning}`);
            }
        } else {
            removedSections.push(section);
            for (const warning of sectionResult.warnings) {
                validationWarnings.push(`${section}: ${warning}`);
            }

            // Keep safe empty defaults for removed sections.
            if (ARRAY_STRING_SECTIONS.includes(section) || section === 'itemExplanations') {
                grounded[section] = [];
            } else {
                grounded[section] = '';
            }
        }
    }

    const total = VALIDATABLE_SECTIONS.length;
    const kept = validatedSections.length;
    const groundingScore = computeGroundingScore(kept, total);

    if (kept === 0) {
        return {
            advisorStatus: VALIDATION_ADVISOR_STATUS.INVALID_RESPONSE,
            validation: {
                schemaVersion: SEMANTIC_VALIDATION_SCHEMA_VERSION,
                validatedSections,
                removedSections,
                validationWarnings,
                groundingScore: 0,
                errors: validationWarnings.slice()
            },
            groundedSemanticResponse: null
        };
    }

    const advisorStatus =
        removedSections.length === 0
            ? VALIDATION_ADVISOR_STATUS.OK
            : VALIDATION_ADVISOR_STATUS.PARTIAL;

    return {
        advisorStatus,
        validation: {
            schemaVersion: SEMANTIC_VALIDATION_SCHEMA_VERSION,
            validatedSections: [...validatedSections],
            removedSections: [...removedSections],
            validationWarnings: [...validationWarnings],
            groundingScore,
            errors: []
        },
        groundedSemanticResponse: grounded
    };
}

function buildUnavailable(message) {
    return {
        advisorStatus: VALIDATION_ADVISOR_STATUS.UNAVAILABLE,
        validation: {
            schemaVersion: SEMANTIC_VALIDATION_SCHEMA_VERSION,
            validatedSections: [],
            removedSections: [...VALIDATABLE_SECTIONS],
            validationWarnings: [message],
            groundingScore: 0,
            errors: [message]
        },
        groundedSemanticResponse: null
    };
}

/**
 * @param {number} kept
 * @param {number} total
 * @returns {number}
 */
function computeGroundingScore(kept, total) {
    if (total <= 0 || kept <= 0) {
        return 0;
    }

    if (kept === total) {
        return 100;
    }

    const removed = total - kept;

    if (removed === 1) {
        return 80;
    }

    // Multiple sections removed — deterministic band + proportional floor.
    const proportional = Math.round((kept / total) * 100);
    return Math.min(50, proportional);
}

function buildFactIndex(context) {
    const items = Array.isArray(context.items) ? context.items : [];
    const byKey = new Map();
    const metadataKeys = new Set();
    const metadataNames = new Set();
    const capabilityStatuses = {
        EXISTENCE: new Set(),
        GRAPH: new Set(),
        CONTRACT: new Set(),
        SEMANTIC: new Set()
    };

    let anySkipAuthorized = false;
    let anyDeployRequired = false;

    for (const item of items) {
        const type = item?.metadataType || null;
        const name = item?.metadataName || null;

        if (!type || !name) {
            continue;
        }

        const key = metadataKey(type, name);
        byKey.set(key, item);
        metadataKeys.add(key);
        metadataNames.add(name);
        metadataNames.add(`${type}:${name}`);
        metadataNames.add(`${type}.${name}`);

        for (const capabilityId of CAPABILITY_IDS) {
            const status = item?.capabilities?.[capabilityId]?.status;
            if (status) {
                capabilityStatuses[capabilityId].add(String(status).toUpperCase());
            }
        }

        if (isSkipAuthorized(item)) {
            anySkipAuthorized = true;
        } else {
            anyDeployRequired = true;
        }
    }

    const packageNames = Array.isArray(context.package?.componentNamesSample)
        ? context.package.componentNamesSample
        : [];

    for (const sample of packageNames) {
        if (typeof sample === 'string' && sample.includes(':')) {
            metadataNames.add(sample);
            const [type, name] = sample.split(':');
            if (type && name) {
                metadataKeys.add(metadataKey(type, name));
                metadataNames.add(name);
            }
        }
    }

    return {
        byKey,
        metadataKeys,
        metadataNames,
        capabilityStatuses,
        anySkipAuthorized,
        anyDeployRequired,
        riskIndicators: new Set(
            Array.isArray(context.summary?.riskIndicators)
                ? context.summary.riskIndicators.map(String)
                : []
        )
    };
}

function metadataKey(type, name) {
    return `${type}::${name}`;
}

function isSkipAuthorized(item) {
    if (item?.authorization?.authorized === true) {
        return true;
    }

    if (item?.planner?.authorized === true) {
        return true;
    }

    const choice = normalizeDecision(
        item?.planner?.choice || item?.planner?.effectiveDecision
    );

    return choice === 'SKIP';
}

function normalizeDecision(value) {
    if (value == null) {
        return null;
    }

    const text = String(value).trim().toUpperCase();

    if (text === 'SKIP' || text === 'SKIPELIGIBLE' || text === 'SKIP_ELIGIBLE') {
        return 'SKIP';
    }

    if (text === 'DEPLOY' || text === 'DEPLOYREQUIRED' || text === 'DEPLOY_REQUIRED') {
        return 'DEPLOY';
    }

    return text;
}

function validateSection(section, value, factIndex, context) {
    if (STRING_SECTIONS.includes(section)) {
        return validateTextSection(value, factIndex, { allowEmpty: true });
    }

    if (ARRAY_STRING_SECTIONS.includes(section)) {
        return validateStringArraySection(section, value, factIndex);
    }

    if (section === 'itemExplanations') {
        return validateItemExplanations(value, factIndex, context);
    }

    return {
        valid: false,
        value: null,
        warnings: [`Unknown section ${section}`]
    };
}

function validateTextSection(text, factIndex, { allowEmpty }) {
    if (typeof text !== 'string') {
        return { valid: false, value: null, warnings: ['Section must be a string.'] };
    }

    if (!text.trim()) {
        return allowEmpty
            ? { valid: true, value: text, warnings: [] }
            : { valid: false, value: null, warnings: ['Section is empty.'] };
    }

    const warnings = collectTextViolations(text, factIndex);

    if (warnings.length > 0) {
        return { valid: false, value: null, warnings };
    }

    return { valid: true, value: text, warnings: [] };
}

function validateStringArraySection(section, values, factIndex) {
    if (!Array.isArray(values)) {
        return { valid: false, value: null, warnings: ['Section must be an array.'] };
    }

    const warnings = [];
    const kept = [];

    for (let index = 0; index < values.length; index += 1) {
        const entry = values[index];

        if (typeof entry !== 'string') {
            warnings.push(`Entry[${index}] is not a string.`);
            continue;
        }

        const entryWarnings = collectTextViolations(entry, factIndex, {
            section
        });

        if (entryWarnings.length > 0) {
            warnings.push(...entryWarnings.map((warning) => `Entry[${index}] ${warning}`));
            continue;
        }

        kept.push(entry);
    }

    // recommendations/warnings: drop bad entries; section fails only if all bad and any existed
    if (section === 'recommendations' || section === 'warnings') {
        if (values.length > 0 && kept.length === 0) {
            return {
                valid: false,
                value: null,
                warnings: warnings.length
                    ? warnings
                    : ['All entries failed grounding.']
            };
        }

        // Partial entry removal inside section still counts as section-valid with filtered list,
        // but record warnings for transparency when some entries dropped.
        if (warnings.length > 0 && kept.length > 0) {
            return {
                valid: true,
                value: kept,
                warnings
            };
        }

        return { valid: true, value: kept, warnings: [] };
    }

    // riskSummary / impactSummary — require full array grounding (no invented claims).
    if (warnings.length > 0) {
        return { valid: false, value: null, warnings };
    }

    return { valid: true, value: values.slice(), warnings: [] };
}

function validateItemExplanations(items, factIndex, context) {
    if (!Array.isArray(items)) {
        return { valid: false, value: null, warnings: ['itemExplanations must be an array.'] };
    }

    const warnings = [];
    const kept = [];

    for (let index = 0; index < items.length; index += 1) {
        const entry = items[index];
        const entryWarnings = validateItemExplanationEntry(entry, factIndex);

        if (entryWarnings.length > 0) {
            warnings.push(
                ...entryWarnings.map(
                    (warning) => `itemExplanations[${index}] ${warning}`
                )
            );
            continue;
        }

        kept.push({
            metadataType: entry.metadataType,
            metadataName: entry.metadataName,
            decision:
                typeof entry.decision === 'string' ? entry.decision : null,
            reasoning: entry.reasoning,
            groundedOn: Array.isArray(entry.groundedOn)
                ? entry.groundedOn.map(String)
                : []
        });
    }

    if (items.length > 0 && kept.length === 0) {
        return {
            valid: false,
            value: null,
            warnings: warnings.length
                ? warnings
                : ['All item explanations failed grounding.']
        };
    }

    // If some items removed, keep section as valid with filtered items (PARTIAL at top level
    // only when whole sections removed). Record warnings for dropped items.
    if (warnings.length > 0 && kept.length < items.length) {
        // Treat partial item drops as section-level issue → remove whole section for stricter guardrails
        // when any invented metadata appears. User asked: reject invented metadata.
        const hasInventedMetadata = warnings.some((warning) =>
            /not present in context/i.test(warning)
        );

        if (hasInventedMetadata) {
            return { valid: false, value: null, warnings };
        }
    }

    return {
        valid: true,
        value: kept,
        warnings: warnings.length && kept.length < items.length ? warnings : []
    };
}

function validateItemExplanationEntry(entry, factIndex) {
    const warnings = [];

    if (!entry || typeof entry !== 'object') {
        return ['Entry must be an object.'];
    }

    const type = entry.metadataType;
    const name = entry.metadataName;

    if (typeof type !== 'string' || typeof name !== 'string') {
        return ['metadataType and metadataName must be strings.'];
    }

    const key = metadataKey(type, name);

    if (!factIndex.byKey.has(key)) {
        return [`Metadata ${type}:${name} is not present in context.`];
    }

    const item = factIndex.byKey.get(key);

    if (typeof entry.reasoning !== 'string') {
        warnings.push('reasoning must be a string.');
    } else {
        warnings.push(
            ...collectTextViolations(entry.reasoning, factIndex, {
                boundItem: item
            })
        );
    }

    const aiDecision = normalizeDecision(entry.decision);
    const plannerDecision = normalizeDecision(
        item.planner?.choice || item.planner?.effectiveDecision
    );

    if (aiDecision === 'SKIP' && !isSkipAuthorized(item)) {
        warnings.push(
            'Decision Skip is not authorized by planner facts for this item.'
        );
    }

    if (
        aiDecision === 'DEPLOY' &&
        plannerDecision === 'SKIP' &&
        isSkipAuthorized(item)
    ) {
        // AI may describe package deploy composition; only reject explicit override language in reasoning.
        // Allow Deploy label when planner choice was SKIP but user still deploying? Safer: allow Deploy
        // only when planner did not authorize Skip. Here planner authorized Skip — claiming Deploy
        // as the planner decision is misleading.
        warnings.push(
            'Decision Deploy contradicts planner Skip authorization for this item.'
        );
    }

    if (Array.isArray(entry.groundedOn)) {
        for (const capabilityId of entry.groundedOn) {
            const upper = String(capabilityId).toUpperCase();

            if (!CAPABILITY_IDS.includes(upper)) {
                warnings.push(`Unknown groundedOn capability ${capabilityId}.`);
                continue;
            }

            const status = item.capabilities?.[upper]?.status;
            if (!status) {
                warnings.push(
                    `groundedOn ${upper} has no capability status in context.`
                );
            }
        }
    }

    return warnings;
}

function collectTextViolations(text, factIndex, options = {}) {
    const warnings = [];
    const boundItem = options.boundItem || null;

    for (const pattern of UNSAFE_ADVICE_PATTERNS) {
        if (pattern.test(text)) {
            warnings.push(`Unsafe advisory language matched ${pattern}.`);
        }
    }

    // Decision override: recommending Skip when planner requires Deploy.
    if (factIndex.anyDeployRequired && !boundItem) {
        for (const pattern of DECISION_OVERRIDE_PATTERNS) {
            if (pattern.test(text)) {
                warnings.push(
                    'Text recommends Skip while planner requires Deploy for one or more items.'
                );
                break;
            }
        }
    }

    if (boundItem && !isSkipAuthorized(boundItem)) {
        for (const pattern of DECISION_OVERRIDE_PATTERNS) {
            if (pattern.test(text)) {
                warnings.push(
                    'Text recommends Skip while planner did not authorize Skip for this item.'
                );
                break;
            }
        }
    }

    warnings.push(...findCapabilityClaimViolations(text, factIndex, boundItem));
    warnings.push(...findInventedMetadataViolations(text, factIndex));

    return warnings;
}

function findCapabilityClaimViolations(text, factIndex, boundItem) {
    const warnings = [];
    const claimPattern = new RegExp(
        `\\b(${CAPABILITY_IDS.join('|')})\\s+(${CAPABILITY_STATUSES.join('|')})\\b`,
        'gi'
    );

    let match = claimPattern.exec(text);

    while (match) {
        const capabilityId = match[1].toUpperCase();
        const claimedStatus = match[2].toUpperCase();

        if (boundItem) {
            const actual =
                boundItem.capabilities?.[capabilityId]?.status || null;

            if (!actual) {
                warnings.push(
                    `Claimed ${capabilityId} ${claimedStatus} but capability is absent for item.`
                );
            } else if (String(actual).toUpperCase() !== claimedStatus) {
                warnings.push(
                    `Claimed ${capabilityId} ${claimedStatus} but planner has ${actual}.`
                );
            }
        } else {
            const statuses = factIndex.capabilityStatuses[capabilityId];

            if (claimedStatus === 'PASS') {
                const hasFail = [...statuses].some(
                    (status) => status === 'FAIL'
                );
                if (hasFail || !statuses.has('PASS')) {
                    warnings.push(
                        `Claimed ${capabilityId} PASS which is not grounded in planner facts.`
                    );
                }
            } else if (!statuses.has(claimedStatus)) {
                warnings.push(
                    `Claimed ${capabilityId} ${claimedStatus} which does not appear in planner facts.`
                );
            }
        }

        match = claimPattern.exec(text);
    }

    return warnings;
}

function findInventedMetadataViolations(text, factIndex) {
    const warnings = [];

    // Match Type:Name or Type.Name for known Salesforce custom suffixes / common types.
    const mentionPattern =
        /\b(CustomField|CustomObject|CustomTab|ApexClass|ApexTrigger|CustomLabel|CustomMetadata|NamedCredential|PermissionSet|Profile|Layout|Flow|FlexiPage)\s*[:.]\s*([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9_]*)\b/g;

    let match = mentionPattern.exec(text);

    while (match) {
        const type = match[1];
        const name = match[2];
        const key = metadataKey(type, name);
        const altKey = metadataNamesContain(factIndex, type, name);

        if (!factIndex.metadataKeys.has(key) && !altKey) {
            warnings.push(
                `Invented metadata reference ${type}:${name} is not present in context.`
            );
        }

        match = mentionPattern.exec(text);
    }

    return warnings;
}

function metadataNamesContain(factIndex, type, name) {
    if (factIndex.metadataNames.has(name)) {
        // Name alone is ambiguous; only accept if unique key exists for type+name
        return factIndex.metadataKeys.has(metadataKey(type, name));
    }

    if (factIndex.metadataNames.has(`${type}:${name}`)) {
        return true;
    }

    return false;
}

module.exports = {
    validateSemanticGrounding,
    computeGroundingScore,
    buildFactIndex,
    VALIDATION_ADVISOR_STATUS,
    SEMANTIC_VALIDATION_SCHEMA_VERSION,
    VALIDATABLE_SECTIONS
};
