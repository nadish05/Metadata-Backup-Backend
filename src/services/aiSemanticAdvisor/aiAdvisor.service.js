/**
 * AI Semantic Advisor — API orchestration (Phase 10E).
 *
 * Builds context → LLM adapter → semantic grounding.
 * Does not execute planner, touch TRUST_POLICY, or expose secrets.
 */

const {
    buildAiContext,
    validateAiContext
} = require('./aiContextBuilder.service');
const {
    generateSemanticResponse,
    ADVISOR_STATUS
} = require('./llmAdapter.service');
const {
    validateSemanticGrounding,
    VALIDATION_ADVISOR_STATUS
} = require('./semanticValidator.service');

/**
 * Run the advisory pipeline from in-memory planner objects.
 *
 * @param {object} [body]
 * @returns {Promise<object>}
 */
async function runAiAdvisor(body = {}) {
    const inputs = normalizeAdvisorInputs(body);

    const { context, validation: contextValidation } = buildAiContext({
        plannerDecisions: inputs.plannerDecisions,
        plannerCompatibility: inputs.plannerCompatibility,
        generatedDeploymentPackage: inputs.generatedDeploymentPackage,
        deploymentSummary: inputs.deploymentSummary,
        request: inputs.request,
        options: inputs.options
    });

    if (!contextValidation.valid || !context) {
        return buildApiResult({
            success: false,
            advisorStatus: ADVISOR_STATUS.INVALID_RESPONSE,
            groundingScore: 0,
            semanticResponse: null,
            validationWarnings: contextValidation.errors.slice(),
            diagnostics: {
                stage: 'CONTEXT',
                errorCode: ADVISOR_STATUS.INVALID_RESPONSE,
                errorMessage: 'AI context validation failed.',
                contextErrors: contextValidation.errors.slice(),
                provider: null,
                latencyMs: 0,
                tokenUsage: null
            },
            httpStatus: 422
        });
    }

    // Explicit second pass (pipeline contract).
    const revalidated = validateAiContext(context);
    if (!revalidated.valid) {
        return buildApiResult({
            success: false,
            advisorStatus: ADVISOR_STATUS.INVALID_RESPONSE,
            groundingScore: 0,
            semanticResponse: null,
            validationWarnings: revalidated.errors.slice(),
            diagnostics: {
                stage: 'CONTEXT',
                errorCode: ADVISOR_STATUS.INVALID_RESPONSE,
                errorMessage: 'AI context re-validation failed.',
                contextErrors: revalidated.errors.slice(),
                provider: null,
                latencyMs: 0,
                tokenUsage: null
            },
            httpStatus: 422
        });
    }

    const adapterResult = await generateSemanticResponse(context, {
        enabled: inputs.options.enabled,
        provider: inputs.options.provider,
        timeoutMs: inputs.options.timeoutMs,
        model: inputs.options.model
    });

    const adapterDiagnostics = sanitizeDiagnostics(adapterResult.diagnostics);

    if (adapterResult.advisorStatus === ADVISOR_STATUS.DISABLED) {
        return buildApiResult({
            success: true,
            advisorStatus: ADVISOR_STATUS.DISABLED,
            groundingScore: 0,
            semanticResponse: null,
            validationWarnings: [],
            diagnostics: {
                ...adapterDiagnostics,
                stage: 'ADAPTER'
            },
            httpStatus: 200
        });
    }

    if (adapterResult.advisorStatus !== ADVISOR_STATUS.OK) {
        return buildApiResult({
            success: false,
            advisorStatus: adapterResult.advisorStatus,
            groundingScore: 0,
            semanticResponse: null,
            validationWarnings: adapterDiagnostics.errorMessage
                ? [adapterDiagnostics.errorMessage]
                : [],
            diagnostics: {
                ...adapterDiagnostics,
                stage: 'ADAPTER'
            },
            httpStatus: mapAdvisorStatusToHttp(adapterResult.advisorStatus)
        });
    }

    const grounding = validateSemanticGrounding(
        context,
        adapterResult.semanticResponse
    );

    const groundingScore =
        typeof grounding.validation?.groundingScore === 'number'
            ? grounding.validation.groundingScore
            : 0;

    const success =
        grounding.advisorStatus === VALIDATION_ADVISOR_STATUS.OK ||
        grounding.advisorStatus === VALIDATION_ADVISOR_STATUS.PARTIAL;

    return buildApiResult({
        success,
        advisorStatus: grounding.advisorStatus,
        groundingScore,
        semanticResponse: grounding.groundedSemanticResponse,
        validationWarnings: [
            ...(grounding.validation?.validationWarnings || [])
        ],
        diagnostics: {
            ...adapterDiagnostics,
            stage: 'VALIDATOR',
            validatedSections: grounding.validation?.validatedSections || [],
            removedSections: grounding.validation?.removedSections || [],
            validationSchemaVersion: grounding.validation?.schemaVersion || null
        },
        httpStatus: success
            ? 200
            : mapAdvisorStatusToHttp(grounding.advisorStatus)
    });
}

function normalizeAdvisorInputs(body) {
    const source = body && typeof body === 'object' ? body : {};

    let plannerDecisions = [];

    if (Array.isArray(source.plannerDecisions)) {
        plannerDecisions = source.plannerDecisions.filter(Boolean);
    } else if (source.plannerDecision && typeof source.plannerDecision === 'object') {
        plannerDecisions = [source.plannerDecision];
    }

    // authorizationTrace is accepted for forward-compat but never rebuilt —
    // facts must already live on plannerDecision / compatibility rows.
    void source.authorizationTrace;

    let generatedDeploymentPackage = null;

    if (
        source.generatedDeploymentPackage &&
        typeof source.generatedDeploymentPackage === 'object'
    ) {
        generatedDeploymentPackage = source.generatedDeploymentPackage;
    } else if (source.packageSummary && typeof source.packageSummary === 'object') {
        generatedDeploymentPackage = {
            summary: {
                metadataCount: numberOrZero(source.packageSummary.metadataCount),
                dependencyCount: numberOrZero(
                    source.packageSummary.dependencyCount
                ),
                testClassCount: numberOrZero(source.packageSummary.testClassCount),
                totalComponents: numberOrZero(
                    source.packageSummary.totalComponents
                )
            },
            metadata: [],
            dependencies: [],
            testClasses: []
        };
    }

    return {
        plannerDecisions,
        plannerCompatibility: source.plannerCompatibility || null,
        generatedDeploymentPackage,
        deploymentSummary: source.deploymentSummary || null,
        request: {
            validationId: source.request?.validationId || source.validationId || null,
            mode: source.request?.mode || source.mode || null
        },
        options: {
            generatedAt: source.options?.generatedAt || null,
            maxItems: source.options?.maxItems,
            enabled: source.options?.enabled,
            provider: source.options?.provider,
            timeoutMs: source.options?.timeoutMs,
            model: source.options?.model
        }
    };
}

function buildApiResult({
    success,
    advisorStatus,
    groundingScore,
    semanticResponse,
    validationWarnings,
    diagnostics,
    httpStatus
}) {
    return {
        success: success === true,
        advisorStatus,
        groundingScore,
        semanticResponse,
        validationWarnings: Array.isArray(validationWarnings)
            ? validationWarnings
            : [],
        diagnostics: sanitizeDiagnostics(diagnostics),
        httpStatus: httpStatus || 200
    };
}

function sanitizeDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object') {
        return {
            stage: null,
            provider: null,
            latencyMs: 0,
            tokenUsage: null,
            errorCode: null,
            errorMessage: null
        };
    }

    return {
        stage: diagnostics.stage || null,
        provider: diagnostics.provider || null,
        model: typeof diagnostics.model === 'string' ? diagnostics.model : null,
        latencyMs:
            typeof diagnostics.latencyMs === 'number' ? diagnostics.latencyMs : 0,
        tokenUsage: diagnostics.tokenUsage
            ? {
                  promptTokens: diagnostics.tokenUsage.promptTokens ?? null,
                  completionTokens:
                      diagnostics.tokenUsage.completionTokens ?? null,
                  totalTokens: diagnostics.tokenUsage.totalTokens ?? null
              }
            : null,
        errorCode: diagnostics.errorCode || null,
        errorMessage: sanitizePublicMessage(diagnostics.errorMessage),
        enabled:
            typeof diagnostics.enabled === 'boolean' ? diagnostics.enabled : null,
        validatedSections: Array.isArray(diagnostics.validatedSections)
            ? diagnostics.validatedSections
            : undefined,
        removedSections: Array.isArray(diagnostics.removedSections)
            ? diagnostics.removedSections
            : undefined,
        validationSchemaVersion: diagnostics.validationSchemaVersion || undefined,
        contextErrors: Array.isArray(diagnostics.contextErrors)
            ? diagnostics.contextErrors.map(sanitizePublicMessage)
            : undefined
    };
}

function sanitizePublicMessage(message) {
    if (typeof message !== 'string') {
        return null;
    }

    return message
        .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[redacted]')
        .slice(0, 500);
}

function mapAdvisorStatusToHttp(status) {
    switch (status) {
        case ADVISOR_STATUS.DISABLED:
        case ADVISOR_STATUS.OK:
        case VALIDATION_ADVISOR_STATUS.OK:
        case VALIDATION_ADVISOR_STATUS.PARTIAL:
            return 200;
        case ADVISOR_STATUS.AUTH_FAILURE:
            return 401;
        case ADVISOR_STATUS.RATE_LIMITED:
            return 429;
        case ADVISOR_STATUS.TIMEOUT:
        case ADVISOR_STATUS.UNAVAILABLE:
        case VALIDATION_ADVISOR_STATUS.UNAVAILABLE:
            return 503;
        case ADVISOR_STATUS.INVALID_RESPONSE:
        case VALIDATION_ADVISOR_STATUS.INVALID_RESPONSE:
            return 422;
        default:
            return 500;
    }
}

function numberOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

module.exports = {
    runAiAdvisor,
    normalizeAdvisorInputs,
    mapAdvisorStatusToHttp,
    sanitizeDiagnostics
};
