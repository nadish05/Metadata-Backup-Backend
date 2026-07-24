/**
 * MOCK LLM provider — deterministic semantic response from context facts.
 * No network. Used for tests and offline shadow runs.
 */

const {
    createEmptySemanticResponse
} = require('../semanticResponse.schema');
const { ProviderError } = require('./providerUtils');
const { ADVISOR_STATUS } = require('../semanticResponse.schema');

const PROVIDER_ID = 'MOCK';

/**
 * @param {object} params
 * @param {object} params.context
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{
 *   text: string,
 *   tokenUsage: null,
 *   model: string
 * }>}
 */
async function generate({ context } = {}) {
    if (!context || typeof context !== 'object') {
        throw new ProviderError(
            ADVISOR_STATUS.INVALID_RESPONSE,
            'MOCK provider requires a validated context object.'
        );
    }

    const response = createEmptySemanticResponse();
    const items = Array.isArray(context.items) ? context.items : [];
    const riskIndicators = Array.isArray(context.summary?.riskIndicators)
        ? context.summary.riskIndicators
        : [];
    const denied = context.summary?.authorization?.denied || 0;
    const granted = context.summary?.authorization?.granted || 0;
    const packageTotal = context.summary?.package?.totalComponents || 0;

    response.executiveSummary = [
        `Planner reviewed ${items.length} metadata item(s).`,
        `Authorization granted=${granted}, denied=${denied}.`,
        `Package components=${packageTotal}.`
    ].join(' ');

    response.developerSummary = [
        'Deterministic MOCK explanation grounded on planner context only.',
        riskIndicators.length
            ? `Risk indicators: ${riskIndicators.join(', ')}.`
            : 'No risk indicators reported.'
    ].join(' ');

    response.deploymentExplanation =
        'Skip/Deploy outcomes are authoritative planner decisions; this response only narrates provided facts.';

    response.riskSummary = riskIndicators.map(String);
    response.impactSummary = [
        `${items.length} item(s) included in advisor context.`,
        `${packageTotal} package component(s) summarized.`
    ];
    response.deploymentOrderExplanation =
        'Deployment order is determined by the planner and package composition, not by this advisor.';
    response.recommendations = [
        'Review authorization DENIED and CONTRACT/GRAPH FAIL items before deploy.'
    ];
    response.warnings = riskIndicators.includes('CONTRACT_FAIL')
        ? ['One or more CONTRACT failures were reported by the planner.']
        : [];

    response.itemExplanations = items.map((item) => {
        const groundedOn = [];

        if (item?.capabilities?.EXISTENCE?.status) {
            groundedOn.push('EXISTENCE');
        }
        if (item?.capabilities?.GRAPH?.status) {
            groundedOn.push('GRAPH');
        }
        if (item?.capabilities?.CONTRACT?.status) {
            groundedOn.push('CONTRACT');
        }

        return {
            metadataType: item.metadataType || 'Unknown',
            metadataName: item.metadataName || 'Unknown',
            decision:
                item.planner?.choice ||
                item.planner?.effectiveDecision ||
                null,
            reasoning: [
                item.reason || item.planner?.reason || 'No reason provided.',
                item.authorization?.availability
                    ? `Authorization ${item.authorization.availability}.`
                    : null
            ]
                .filter(Boolean)
                .join(' '),
            groundedOn
        };
    });

    response.confidenceStatement =
        'MOCK provider confidence is informational only and grounded solely on provided planner facts.';

    return {
        text: JSON.stringify(response),
        tokenUsage: null,
        model: 'mock-deterministic'
    };
}

module.exports = {
    PROVIDER_ID,
    generate
};
