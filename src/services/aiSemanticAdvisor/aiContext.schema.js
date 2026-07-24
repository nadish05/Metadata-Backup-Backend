/**
 * AI Semantic Advisor — Context schema & validation (Phase 10B).
 *
 * Deterministic bounds for the Context Builder.
 * No LLM / prompts / network.
 */

const AI_CONTEXT_SCHEMA_VERSION = '10B.1';
const AI_CONTEXT_VERSION = '10B.1';
const AI_PLANNER_VERSION = 'planner-10B';

const DEFAULT_MAX_ITEMS = 100;
const MAX_REASON_LENGTH = 500;
const MAX_MISMATCHES = 20;
const MAX_BLOCKING_DEPENDS_ON = 20;
const MAX_RISK_INDICATORS = 32;
const MAX_COMPONENT_NAME_SAMPLES = 40;

/** Keys that must never appear in context payloads. */
const SECRET_KEY_PATTERN =
    /^(password|passwd|secret|secrets|token|tokens|credential|credentials|apikey|api_key|clientsecret|client_secret|accesskey|access_token|accesstoken|privatekey|private_key|refresh_token|refreshtoken|bearer|sessionid|session_id)$/i;

const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
    'xml',
    'sourceXml',
    'rawXml',
    'filePath',
    'fileContents',
    'repositoryPath',
    'workspacePath',
    'clientSecret',
    'accessToken',
    'refreshToken',
    'password',
    'privateKey'
]);

const REQUIRED_TOP_LEVEL_SECTIONS = Object.freeze([
    'schemaVersion',
    'request',
    'summary',
    'items',
    'package',
    'constraints',
    'advisorMetadata'
]);

const DEFAULT_CONSTRAINTS = Object.freeze({
    aiMustNotChangeDecisions: true,
    groundOnlyOnProvidedFacts: true,
    plannerIsAuthoritative: true,
    noRepositoryContents: true,
    secretsExcluded: true
});

const RISK_INDICATORS = Object.freeze({
    EXISTENCE_FAIL: 'EXISTENCE_FAIL',
    EXISTENCE_UNKNOWN: 'EXISTENCE_UNKNOWN',
    GRAPH_FAIL: 'GRAPH_FAIL',
    GRAPH_UNKNOWN: 'GRAPH_UNKNOWN',
    GRAPH_BLOCKED: 'GRAPH_BLOCKED',
    CONTRACT_FAIL: 'CONTRACT_FAIL',
    CONTRACT_UNKNOWN: 'CONTRACT_UNKNOWN',
    AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
    AUTHORIZATION_UNAVAILABLE: 'AUTHORIZATION_UNAVAILABLE',
    FALLBACK_USED: 'FALLBACK_USED',
    UNKNOWN_DESTINATION: 'UNKNOWN_DESTINATION',
    MISSING_DESTINATION: 'MISSING_DESTINATION'
});

/**
 * @param {object|null|undefined} context
 * @param {{ maxItems?: number }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAiContext(context, options = {}) {
    const errors = [];
    const maxItems =
        Number.isInteger(options.maxItems) && options.maxItems > 0
            ? options.maxItems
            : DEFAULT_MAX_ITEMS;

    if (!context || typeof context !== 'object' || Array.isArray(context)) {
        return { valid: false, errors: ['Context must be a non-null object.'] };
    }

    for (const section of REQUIRED_TOP_LEVEL_SECTIONS) {
        if (!(section in context)) {
            errors.push(`Missing required section: ${section}`);
        }
    }

    if (context.schemaVersion !== AI_CONTEXT_SCHEMA_VERSION) {
        errors.push(
            `schemaVersion must be ${AI_CONTEXT_SCHEMA_VERSION}; got ${context.schemaVersion}`
        );
    }

    if (!context.request || typeof context.request !== 'object') {
        errors.push('request must be an object.');
    }

    if (!context.summary || typeof context.summary !== 'object') {
        errors.push('summary must be an object.');
    } else {
        for (const key of [
            'planner',
            'capabilities',
            'authorization',
            'package',
            'riskIndicators'
        ]) {
            if (!(key in context.summary)) {
                errors.push(`summary.${key} is required.`);
            }
        }
    }

    if (!Array.isArray(context.items)) {
        errors.push('items must be an array.');
    } else if (context.items.length > maxItems) {
        errors.push(
            `items length ${context.items.length} exceeds maxItems ${maxItems}.`
        );
    } else {
        context.items.forEach((item, index) => {
            if (!item || typeof item !== 'object') {
                errors.push(`items[${index}] must be an object.`);
                return;
            }

            if (!item.metadataType || !item.metadataName) {
                errors.push(
                    `items[${index}] requires metadataType and metadataName.`
                );
            }

            if (!item.planner || typeof item.planner !== 'object') {
                errors.push(`items[${index}].planner is required.`);
            }
        });
    }

    if (!context.package || typeof context.package !== 'object') {
        errors.push('package must be an object.');
    }

    if (!context.constraints || typeof context.constraints !== 'object') {
        errors.push('constraints must be an object.');
    } else {
        if (context.constraints.aiMustNotChangeDecisions !== true) {
            errors.push('constraints.aiMustNotChangeDecisions must be true.');
        }
        if (context.constraints.groundOnlyOnProvidedFacts !== true) {
            errors.push('constraints.groundOnlyOnProvidedFacts must be true.');
        }
        if (context.constraints.plannerIsAuthoritative !== true) {
            errors.push('constraints.plannerIsAuthoritative must be true.');
        }
    }

    if (!context.advisorMetadata || typeof context.advisorMetadata !== 'object') {
        errors.push('advisorMetadata must be an object.');
    } else {
        if (context.advisorMetadata.contextVersion !== AI_CONTEXT_VERSION) {
            errors.push(
                `advisorMetadata.contextVersion must be ${AI_CONTEXT_VERSION}.`
            );
        }
        if (
            typeof context.advisorMetadata.itemCount !== 'number' ||
            context.advisorMetadata.itemCount !== (context.items || []).length
        ) {
            errors.push(
                'advisorMetadata.itemCount must equal items.length.'
            );
        }
    }

    const secretHits = findForbiddenContent(context);
    for (const hit of secretHits) {
        errors.push(hit);
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Walk payload for forbidden keys / secret-like property names.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
function findForbiddenContent(value, path = 'context') {
    const errors = [];

    if (value == null) {
        return errors;
    }

    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            errors.push(...findForbiddenContent(entry, `${path}[${index}]`));
        });
        return errors;
    }

    if (typeof value !== 'object') {
        if (typeof value === 'string' && looksLikeSecretValue(value)) {
            errors.push(`Possible secret value at ${path}.`);
        }
        return errors;
    }

    for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;

        if (FORBIDDEN_PAYLOAD_KEYS.includes(key) || SECRET_KEY_PATTERN.test(key)) {
            errors.push(`Forbidden or secret-like key at ${childPath}.`);
            continue;
        }

        errors.push(...findForbiddenContent(child, childPath));
    }

    return errors;
}

function looksLikeSecretValue(value) {
    if (typeof value !== 'string' || value.length < 24) {
        return false;
    }

    // Long opaque tokens (avoid flagging normal reason strings).
    return /^[A-Za-z0-9+/=_-]{40,}$/.test(value);
}

module.exports = {
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
    REQUIRED_TOP_LEVEL_SECTIONS,
    DEFAULT_CONSTRAINTS,
    RISK_INDICATORS,
    validateAiContext,
    findForbiddenContent
};
