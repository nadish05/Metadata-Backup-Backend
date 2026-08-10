const {
    generateOnDemandAiResolution,
    sanitizeAiResolutionContext,
    UnsupportedAiProviderError
} = require('../services/aiDeploymentAdvisor/aiDeploymentAdvisor.service');

/**
 * Phase 17.7 — On-demand AI Deployment Resolution.
 * Advisory only. Never executes deployment or mutates metadata.
 */
exports.resolveDeploymentWithAi = async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { provider, context } = body;

        // Explicitly ignore client-supplied secrets / model / prompts.
        // Never forward apiKey, model, systemPrompt, tokens, or credentials.

        console.log(
            '[AI Resolution] POST /api/deployment/ai-resolution received provider=' +
                String(provider ?? '')
        );

        const sanitizedContext = sanitizeAiResolutionContext(context);
        const aiResolutionReport = await generateOnDemandAiResolution(
            sanitizedContext,
            provider
        );

        return res.json({
            success: true,
            aiResolutionReport
        });
    } catch (error) {
        if (
            error instanceof UnsupportedAiProviderError ||
            error?.code === 'UNSUPPORTED_AI_PROVIDER'
        ) {
            return res.status(400).json({
                success: false,
                error:
                    error.message ||
                    'Unsupported AI provider. Supported providers: gemini, openai.'
            });
        }

        console.error('ON-DEMAND AI RESOLUTION ERROR');
        console.error(error?.message || error);

        return res.status(500).json({
            success: false,
            error: 'Unable to generate AI deployment resolution.'
        });
    }
};
