/**
 * AI Semantic Advisor — LLM Adapter (Phase 10C).
 *
 * Provider-agnostic entry point. Consumes a validated AI Context (Phase 10B)
 * and returns a structured semantic response.
 *
 * Completely independent of planner / TRUST_POLICY / executors.
 * Never throws into planner control flow — failures become advisorStatus.
 */

const { validateAiContext } = require('./aiContext.schema');
const {
    ADVISOR_STATUS,
    LLM_PROVIDERS,
    SEMANTIC_RESPONSE_SCHEMA_VERSION,
    validateSemanticResponse,
    parseJsonFromModelText,
    createEmptySemanticResponse
} = require('./semanticResponse.schema');
const { resolveProvider, listProviderIds } = require('./llmProviders');
const { ProviderError } = require('./llmProviders/providerUtils');

/**
 * @param {object} [overrides]
 * @returns {{
 *   enabled: boolean,
 *   provider: string,
 *   timeoutMs: number,
 *   apiKey: string|null,
 *   model: string|null
 * }}
 */
function resolveAdapterConfig(overrides = {}) {
    const enabled =
        overrides.enabled !== undefined
            ? overrides.enabled === true
            : parseEnvBool(process.env.AI_ENABLED, false);

    const provider = String(
        overrides.provider || process.env.AI_PROVIDER || LLM_PROVIDERS.MOCK
    )
        .trim()
        .toUpperCase();

    const timeoutMs = resolvePositiveInt(
        overrides.timeoutMs !== undefined
            ? overrides.timeoutMs
            : process.env.AI_TIMEOUT_MS,
        15000
    );

    return {
        enabled,
        provider,
        timeoutMs,
        apiKey:
            overrides.apiKey !== undefined
                ? overrides.apiKey
                : null,
        model: overrides.model !== undefined ? overrides.model : null
    };
}

/**
 * Generate a structured semantic response from validated AI context.
 *
 * @param {object|null} validatedContext
 * @param {object} [options] Config overrides (tests / callers). Never from planner.
 * @returns {Promise<{
 *   advisorStatus: string,
 *   semanticResponse: object|null,
 *   diagnostics: object
 * }>}
 */
async function generateSemanticResponse(validatedContext, options = {}) {
    const startedAt = Date.now();
    const config = resolveAdapterConfig(options);

    const baseDiagnostics = {
        schemaVersion: SEMANTIC_RESPONSE_SCHEMA_VERSION,
        provider: config.provider,
        model: config.model,
        latencyMs: 0,
        tokenUsage: null,
        errorCode: null,
        errorMessage: null,
        enabled: config.enabled
    };

    if (!config.enabled) {
        return buildResult({
            advisorStatus: ADVISOR_STATUS.DISABLED,
            semanticResponse: null,
            diagnostics: {
                ...baseDiagnostics,
                latencyMs: Date.now() - startedAt,
                errorCode: ADVISOR_STATUS.DISABLED,
                errorMessage: 'AI_ENABLED is false; advisor skipped.'
            }
        });
    }

    const contextValidation = validateAiContext(validatedContext);

    if (!contextValidation.valid) {
        return buildResult({
            advisorStatus: ADVISOR_STATUS.INVALID_RESPONSE,
            semanticResponse: null,
            diagnostics: {
                ...baseDiagnostics,
                latencyMs: Date.now() - startedAt,
                errorCode: ADVISOR_STATUS.INVALID_RESPONSE,
                errorMessage: `Invalid AI context: ${contextValidation.errors.join('; ')}`
            }
        });
    }

    const provider = resolveProvider(config.provider);

    if (!provider) {
        return buildResult({
            advisorStatus: ADVISOR_STATUS.UNAVAILABLE,
            semanticResponse: null,
            diagnostics: {
                ...baseDiagnostics,
                latencyMs: Date.now() - startedAt,
                errorCode: ADVISOR_STATUS.UNAVAILABLE,
                errorMessage: `Unknown provider: ${config.provider}. Supported: ${listProviderIds().join(', ')}`
            }
        });
    }

    try {
        const providerArgs = {
            context: validatedContext,
            timeoutMs: config.timeoutMs
        };

        if (config.apiKey != null) {
            providerArgs.apiKey = config.apiKey;
        }

        if (config.model != null) {
            providerArgs.model = config.model;
        }

        const providerResult = await provider.generate(providerArgs);
        const parsed = parseJsonFromModelText(providerResult?.text || '');
        const semanticValidation = validateSemanticResponse(parsed);

        if (!semanticValidation.valid) {
            return buildResult({
                advisorStatus: ADVISOR_STATUS.INVALID_RESPONSE,
                semanticResponse: null,
                diagnostics: {
                    ...baseDiagnostics,
                    provider: provider.PROVIDER_ID || config.provider,
                    model: providerResult?.model || config.model,
                    latencyMs: Date.now() - startedAt,
                    tokenUsage: providerResult?.tokenUsage || null,
                    errorCode: ADVISOR_STATUS.INVALID_RESPONSE,
                    errorMessage: `Provider response failed schema validation: ${semanticValidation.errors.join('; ')}`
                }
            });
        }

        return buildResult({
            advisorStatus: ADVISOR_STATUS.OK,
            semanticResponse: semanticValidation.normalized,
            diagnostics: {
                ...baseDiagnostics,
                provider: provider.PROVIDER_ID || config.provider,
                model: providerResult?.model || config.model,
                latencyMs: Date.now() - startedAt,
                tokenUsage: providerResult?.tokenUsage || null,
                errorCode: null,
                errorMessage: null
            }
        });
    } catch (error) {
        const mapped =
            error instanceof ProviderError
                ? error
                : new ProviderError(
                      ADVISOR_STATUS.UNAVAILABLE,
                      error?.message || String(error)
                  );

        return buildResult({
            advisorStatus: mapped.code || ADVISOR_STATUS.UNAVAILABLE,
            semanticResponse: null,
            diagnostics: {
                ...baseDiagnostics,
                provider: provider.PROVIDER_ID || config.provider,
                latencyMs: Date.now() - startedAt,
                errorCode: mapped.code || ADVISOR_STATUS.UNAVAILABLE,
                errorMessage: mapped.message
            }
        });
    }
}

function buildResult({ advisorStatus, semanticResponse, diagnostics }) {
    return {
        advisorStatus,
        semanticResponse,
        diagnostics: {
            ...diagnostics,
            provider: diagnostics.provider || null,
            latencyMs:
                typeof diagnostics.latencyMs === 'number'
                    ? diagnostics.latencyMs
                    : 0,
            tokenUsage: diagnostics.tokenUsage || null
        }
    };
}

function parseEnvBool(value, defaultValue) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = String(value).trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function resolvePositiveInt(value, fallback) {
    const parsed = Number(value);

    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
    }

    return fallback;
}

module.exports = {
    generateSemanticResponse,
    resolveAdapterConfig,
    ADVISOR_STATUS,
    LLM_PROVIDERS,
    SEMANTIC_RESPONSE_SCHEMA_VERSION,
    createEmptySemanticResponse,
    validateSemanticResponse,
    listProviderIds
};
