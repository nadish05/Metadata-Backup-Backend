/**
 * AI Semantic Advisor API controller (Phase 10E).
 *
 * Exposes validated advisory results. Does not modify planner behavior.
 */

const { runAiAdvisor } = require('../services/aiSemanticAdvisor/aiAdvisor.service');

async function generateAdvisor(req, res) {
    try {
        const result = await runAiAdvisor(req.body || {});

        const { httpStatus, ...payload } = result;

        return res.status(httpStatus || 200).json({
            success: payload.success,
            advisorStatus: payload.advisorStatus,
            groundingScore: payload.groundingScore,
            semanticResponse: payload.semanticResponse,
            validationWarnings: payload.validationWarnings,
            diagnostics: payload.diagnostics
        });
    } catch (_error) {
        // Never leak stack traces or secrets to clients.
        return res.status(500).json({
            success: false,
            advisorStatus: 'UNAVAILABLE',
            groundingScore: 0,
            semanticResponse: null,
            validationWarnings: ['Advisor request failed.'],
            diagnostics: {
                stage: 'CONTROLLER',
                provider: null,
                latencyMs: 0,
                tokenUsage: null,
                errorCode: 'UNAVAILABLE',
                errorMessage: 'Advisor request failed.'
            }
        });
    }
}

module.exports = {
    generateAdvisor
};
