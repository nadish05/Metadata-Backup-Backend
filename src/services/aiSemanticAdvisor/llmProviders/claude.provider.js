/**
 * Claude (Anthropic) provider for the Semantic Advisor LLM Adapter (Phase 10C).
 * Uses HTTPS fetch — no Anthropic SDK dependency required.
 * Minimal prompt plumbing only.
 */

const { ADVISOR_STATUS } = require('../semanticResponse.schema');
const {
    ProviderError,
    MINIMAL_SYSTEM_PROMPT,
    buildMinimalUserPrompt,
    withTimeout,
    mapHttpErrorToProviderError
} = require('./providerUtils');

const PROVIDER_ID = 'CLAUDE';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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
    apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
    model = process.env.AI_CLAUDE_MODEL || 'claude-3-5-haiku-latest'
} = {}) {
    if (!apiKey) {
        throw new ProviderError(
            ADVISOR_STATUS.AUTH_FAILURE,
            'ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is not configured.'
        );
    }

    const body = {
        model,
        max_tokens: 2048,
        temperature: 0,
        system: MINIMAL_SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content: buildMinimalUserPrompt(context)
            }
        ]
    };

    try {
        const response = await withTimeout(timeoutMs, async () => {
            const controller = new AbortController();
            const fetchTimer = setTimeout(
                () => controller.abort(),
                timeoutMs
            );

            try {
                const httpResponse = await fetch(ANTHROPIC_URL, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                const payload = await httpResponse.json().catch(() => ({}));

                if (!httpResponse.ok) {
                    const err = new Error(
                        payload?.error?.message ||
                            `Claude HTTP ${httpResponse.status}`
                    );
                    err.status = httpResponse.status;
                    throw err;
                }

                return payload;
            } finally {
                clearTimeout(fetchTimer);
            }
        });

        const text = Array.isArray(response?.content)
            ? response.content
                  .filter((part) => part?.type === 'text')
                  .map((part) => part.text || '')
                  .join('\n')
            : '';

        const usage = response?.usage || null;

        return {
            text,
            tokenUsage: usage
                ? {
                      promptTokens: usage.input_tokens ?? null,
                      completionTokens: usage.output_tokens ?? null,
                      totalTokens:
                          (usage.input_tokens || 0) + (usage.output_tokens || 0)
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
