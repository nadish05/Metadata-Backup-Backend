/**
 * AI Semantic Advisor — Semantic validation schema (Phase 10D).
 *
 * Guardrail statuses and unsafe-pattern catalogs.
 * No planner coupling.
 */

const SEMANTIC_VALIDATION_SCHEMA_VERSION = '10D.1';

const VALIDATION_ADVISOR_STATUS = Object.freeze({
    OK: 'OK',
    PARTIAL: 'PARTIAL',
    INVALID_RESPONSE: 'INVALID_RESPONSE',
    UNAVAILABLE: 'UNAVAILABLE'
});

/** Sections validated independently for PARTIAL support. */
const VALIDATABLE_SECTIONS = Object.freeze([
    'executiveSummary',
    'developerSummary',
    'deploymentExplanation',
    'riskSummary',
    'impactSummary',
    'deploymentOrderExplanation',
    'recommendations',
    'warnings',
    'itemExplanations',
    'confidenceStatement'
]);

const STRING_SECTIONS = Object.freeze([
    'executiveSummary',
    'developerSummary',
    'deploymentExplanation',
    'deploymentOrderExplanation',
    'confidenceStatement'
]);

const ARRAY_STRING_SECTIONS = Object.freeze([
    'riskSummary',
    'impactSummary',
    'recommendations',
    'warnings'
]);

const CAPABILITY_IDS = Object.freeze([
    'EXISTENCE',
    'GRAPH',
    'CONTRACT',
    'SEMANTIC'
]);

const CAPABILITY_STATUSES = Object.freeze([
    'PASS',
    'FAIL',
    'UNKNOWN',
    'DEFERRED',
    'NOT_EVALUATED'
]);

/** Recommendations / free-text that attempt to override planner. */
const UNSAFE_ADVICE_PATTERNS = Object.freeze([
    /ignore\s+contract/i,
    /ignore\s+graph/i,
    /ignore\s+authorization/i,
    /ignore\s+planner/i,
    /deploy\s+anyway/i,
    /force\s+deploy/i,
    /force\s+skip/i,
    /override\s+(the\s+)?planner/i,
    /override\s+authorization/i,
    /override\s+trust[_\s-]?policy/i,
    /bypass\s+(the\s+)?(planner|authorization|contract|graph|trust)/i,
    /disregard\s+(the\s+)?(planner|contract|authorization|graph)/i,
    /skip\s+despite/i,
    /proceed\s+without\s+(contract|graph|authorization)/i
]);

const DECISION_OVERRIDE_PATTERNS = Object.freeze([
    /recommend(s|ed|ing)?\s+skip\b/i,
    /\bshould\s+skip\b/i,
    /\bmust\s+skip\b/i,
    /\bskip\s+this\s+(field|object|component|item)\b/i
]);

module.exports = {
    SEMANTIC_VALIDATION_SCHEMA_VERSION,
    VALIDATION_ADVISOR_STATUS,
    VALIDATABLE_SECTIONS,
    STRING_SECTIONS,
    ARRAY_STRING_SECTIONS,
    CAPABILITY_IDS,
    CAPABILITY_STATUSES,
    UNSAFE_ADVICE_PATTERNS,
    DECISION_OVERRIDE_PATTERNS
};
