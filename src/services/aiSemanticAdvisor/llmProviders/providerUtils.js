/**
 * Shared provider utilities for the LLM Adapter (Phase 10C).
 */

const {
    ADVISOR_STATUS
} = require('../semanticResponse.schema');

class ProviderError extends Error {
    /**
     * @param {string} code ADVISOR_STATUS value
     * @param {string} message
     * @param {object} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ProviderError';
        this.code = code || ADVISOR_STATUS.UNAVAILABLE;
        this.details = details;
    }
}

const MINIMAL_SYSTEM_PROMPT = [
    'You are a Salesforce metadata deployment explainer.',
    'Return ONLY a single JSON object matching the semantic response schema.',
    'Do not change Skip/Deploy decisions.',
    'Ground explanations only on the provided planner facts.',
    'If a fact is missing, say it was not provided.'
].join(' ');

function buildMinimalUserPrompt(validatedContext) {
    return [
        'Explain the planner decisions in the context below.',
        'Do not reconsider or override any decision.',
        'Respond with JSON only.',
        '',
        'CONTEXT:',
        JSON.stringify(validatedContext)
    ].join('\n');
}

/**
 * @param {number} timeoutMs
 * @param {() => Promise<any>} work
 * @returns {Promise<any>}
 */
async function withTimeout(timeoutMs, work) {
    const ms =
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;

    let timer = null;

    try {
        return await Promise.race([
            work(),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(
                        new ProviderError(
                            ADVISOR_STATUS.TIMEOUT,
                            `Provider timed out after ${ms}ms.`
                        )
                    );
                }, ms);
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

function mapHttpErrorToProviderError(error) {
    if (error instanceof ProviderError) {
        return error;
    }

    const status =
        error?.status ||
        error?.statusCode ||
        error?.response?.status ||
        null;
    const message = error?.message || String(error);

    if (status === 401 || status === 403) {
        return new ProviderError(ADVISOR_STATUS.AUTH_FAILURE, message, {
            status
        });
    }

    if (status === 429) {
        return new ProviderError(ADVISOR_STATUS.RATE_LIMITED, message, {
            status
        });
    }

    if (
        /timeout|etimedout|aborterror|timed out/i.test(message) ||
        error?.code === 'ETIMEDOUT' ||
        error?.code === 'ABORT_ERR'
    ) {
        return new ProviderError(ADVISOR_STATUS.TIMEOUT, message);
    }

    return new ProviderError(ADVISOR_STATUS.UNAVAILABLE, message, { status });
}

module.exports = {
    ProviderError,
    MINIMAL_SYSTEM_PROMPT,
    buildMinimalUserPrompt,
    withTimeout,
    mapHttpErrorToProviderError
};
