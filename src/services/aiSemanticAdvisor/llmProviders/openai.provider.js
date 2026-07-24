/**
 * OpenAI provider for the Semantic Advisor LLM Adapter (Phase 10C).
 * Minimal prompt plumbing only.
 */

const OpenAI = require('openai');
const { ADVISOR_STATUS } = require('../semanticResponse.schema');
const {
    ProviderError,
    MINIMAL_SYSTEM_PROMPT,
    buildMinimalUserPrompt,
    withTimeout,
    mapHttpErrorToProviderError
} = require('./providerUtils');

const PROVIDER_ID = 'OPENAI';

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
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.AI_OPENAI_MODEL || 'gpt-4o-mini'
} = {}) {
    if (!apiKey) {
        throw new ProviderError(
            ADVISOR_STATUS.AUTH_FAILURE,
            'OPENAI_API_KEY is not configured.'
        );
    }

    const openai = new OpenAI({ apiKey });
    const userPrompt = buildMinimalUserPrompt(context);

    try {
        const completion = await withTimeout(timeoutMs, () =>
            openai.chat.completions.create({
                model,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: MINIMAL_SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt }
                ]
            })
        );

        const text = completion?.choices?.[0]?.message?.content || '';
        const usage = completion?.usage || null;

        return {
            text,
            tokenUsage: usage
                ? {
                      promptTokens: usage.prompt_tokens ?? null,
                      completionTokens: usage.completion_tokens ?? null,
                      totalTokens: usage.total_tokens ?? null
                  }
                : null,
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
