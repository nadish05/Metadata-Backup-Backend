/**
 * Provider registry for the Semantic Advisor LLM Adapter (Phase 10C).
 */

const { LLM_PROVIDERS } = require('../semanticResponse.schema');
const mockProvider = require('./mock.provider');
const openaiProvider = require('./openai.provider');
const geminiProvider = require('./gemini.provider');
const claudeProvider = require('./claude.provider');

const PROVIDERS = Object.freeze({
    [LLM_PROVIDERS.MOCK]: mockProvider,
    [LLM_PROVIDERS.OPENAI]: openaiProvider,
    [LLM_PROVIDERS.GEMINI]: geminiProvider,
    [LLM_PROVIDERS.CLAUDE]: claudeProvider
});

/**
 * @param {string} providerId
 * @returns {{ PROVIDER_ID: string, generate: Function }|null}
 */
function resolveProvider(providerId) {
    const normalized = String(providerId || '')
        .trim()
        .toUpperCase();

    return PROVIDERS[normalized] || null;
}

function listProviderIds() {
    return Object.keys(PROVIDERS).sort((a, b) => a.localeCompare(b));
}

module.exports = {
    PROVIDERS,
    resolveProvider,
    listProviderIds
};
