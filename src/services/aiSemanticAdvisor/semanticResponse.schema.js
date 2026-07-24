/**
 * AI Semantic Advisor — Semantic response schema (Phase 10C).
 *
 * Structured output contract for the LLM Adapter.
 * No planner coupling.
 */

const SEMANTIC_RESPONSE_SCHEMA_VERSION = '10C.1';

const ADVISOR_STATUS = Object.freeze({
    OK: 'OK',
    DISABLED: 'DISABLED',
    UNAVAILABLE: 'UNAVAILABLE',
    TIMEOUT: 'TIMEOUT',
    INVALID_RESPONSE: 'INVALID_RESPONSE',
    AUTH_FAILURE: 'AUTH_FAILURE',
    RATE_LIMITED: 'RATE_LIMITED'
});

const LLM_PROVIDERS = Object.freeze({
    MOCK: 'MOCK',
    OPENAI: 'OPENAI',
    GEMINI: 'GEMINI',
    CLAUDE: 'CLAUDE'
});

const REQUIRED_SEMANTIC_FIELDS = Object.freeze([
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

function createEmptySemanticResponse() {
    return {
        schemaVersion: SEMANTIC_RESPONSE_SCHEMA_VERSION,
        executiveSummary: '',
        developerSummary: '',
        deploymentExplanation: '',
        riskSummary: [],
        impactSummary: [],
        deploymentOrderExplanation: '',
        recommendations: [],
        warnings: [],
        itemExplanations: [],
        confidenceStatement: ''
    };
}

/**
 * @param {unknown} value
 * @returns {{ valid: boolean, errors: string[], normalized: object|null }}
 */
function validateSemanticResponse(value) {
    const errors = [];

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            valid: false,
            errors: ['Semantic response must be a non-null object.'],
            normalized: null
        };
    }

    for (const field of REQUIRED_SEMANTIC_FIELDS) {
        if (!(field in value)) {
            errors.push(`Missing required field: ${field}`);
        }
    }

    const stringFields = [
        'executiveSummary',
        'developerSummary',
        'deploymentExplanation',
        'deploymentOrderExplanation',
        'confidenceStatement'
    ];

    for (const field of stringFields) {
        if (field in value && typeof value[field] !== 'string') {
            errors.push(`${field} must be a string.`);
        }
    }

    const arrayFields = [
        'riskSummary',
        'impactSummary',
        'recommendations',
        'warnings',
        'itemExplanations'
    ];

    for (const field of arrayFields) {
        if (field in value && !Array.isArray(value[field])) {
            errors.push(`${field} must be an array.`);
        }
    }

    if (Array.isArray(value.itemExplanations)) {
        value.itemExplanations.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                errors.push(`itemExplanations[${index}] must be an object.`);
                return;
            }

            if (typeof entry.metadataType !== 'string') {
                errors.push(
                    `itemExplanations[${index}].metadataType must be a string.`
                );
            }

            if (typeof entry.metadataName !== 'string') {
                errors.push(
                    `itemExplanations[${index}].metadataName must be a string.`
                );
            }

            if (typeof entry.reasoning !== 'string') {
                errors.push(
                    `itemExplanations[${index}].reasoning must be a string.`
                );
            }
        });
    }

    if (errors.length > 0) {
        return { valid: false, errors, normalized: null };
    }

    const normalized = {
        schemaVersion: SEMANTIC_RESPONSE_SCHEMA_VERSION,
        executiveSummary: value.executiveSummary,
        developerSummary: value.developerSummary,
        deploymentExplanation: value.deploymentExplanation,
        riskSummary: value.riskSummary.map(String),
        impactSummary: value.impactSummary.map(String),
        deploymentOrderExplanation: value.deploymentOrderExplanation,
        recommendations: value.recommendations.map(String),
        warnings: value.warnings.map(String),
        itemExplanations: value.itemExplanations.map((entry) => ({
            metadataType: entry.metadataType,
            metadataName: entry.metadataName,
            decision:
                typeof entry.decision === 'string' ? entry.decision : null,
            reasoning: entry.reasoning,
            groundedOn: Array.isArray(entry.groundedOn)
                ? entry.groundedOn.map(String)
                : []
        })),
        confidenceStatement: value.confidenceStatement
    };

    return { valid: true, errors: [], normalized };
}

/**
 * Extract JSON object from model text (supports optional ```json fences).
 * @param {string} text
 * @returns {object|null}
 */
function parseJsonFromModelText(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return null;
    }

    let candidate = text.trim();
    const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fenceMatch) {
        candidate = fenceMatch[1].trim();
    }

    try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch (_error) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');

        if (start >= 0 && end > start) {
            try {
                const sliced = JSON.parse(candidate.slice(start, end + 1));
                return sliced && typeof sliced === 'object' && !Array.isArray(sliced)
                    ? sliced
                    : null;
            } catch (_inner) {
                return null;
            }
        }

        return null;
    }
}

module.exports = {
    SEMANTIC_RESPONSE_SCHEMA_VERSION,
    ADVISOR_STATUS,
    LLM_PROVIDERS,
    REQUIRED_SEMANTIC_FIELDS,
    createEmptySemanticResponse,
    validateSemanticResponse,
    parseJsonFromModelText
};
