/**
 * Gemini provider for the Semantic Advisor LLM Adapter (Phase 10C).
 * Minimal prompt plumbing only.
 */

const { GoogleGenAI } = require('@google/genai');
const { ADVISOR_STATUS } = require('../semanticResponse.schema');
const {
    ProviderError,
    MINIMAL_SYSTEM_PROMPT,
    buildMinimalUserPrompt,
    withTimeout,
    mapHttpErrorToProviderError
} = require('./providerUtils');

const PROVIDER_ID = 'GEMINI';

/**
 * @param {object} params
 * @param {object} params.context
 * @param {number} [params.timeoutMs]
 * @param {string} [params.apiKey]
 * @param {string} [params.model]
 * @returns {Promise<{ text: string, tokenUsage: object|null, model: string }>}
 */
async function generate({
    context,
    timeoutMs = 15000,
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash'
} = {}) {
    if (!apiKey) {
        throw new ProviderError(
            ADVISOR_STATUS.AUTH_FAILURE,
            'GEMINI_API_KEY is not configured.'
        );
    }

    const ai = new GoogleGenAI({ apiKey });
    const prompt = `${MINIMAL_SYSTEM_PROMPT}\n\n${buildMinimalUserPrompt(context)}`;

    try {
        const response = await withTimeout(timeoutMs, () =>
            ai.models.generateContent({
                model,
                contents: prompt
            })
        );

        const text =
            typeof response?.text === 'string'
                ? response.text
                : typeof response?.text === 'function'
                  ? response.text()
                  : '';

        return {
            text: typeof text === 'string' ? text : String(text || ''),
            tokenUsage: null,
            model
        };
    } catch (error) {
        throw mapHttpErrorToProviderError(error);
    }
}

module.exports = {
    PROVIDER_ID,
    generate
};
