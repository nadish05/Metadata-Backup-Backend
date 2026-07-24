/**
 * Planner Authorization Framework — Phase 7C.
 *
 * Separates policy (authorization) from analyzer facts (capabilities).
 *
 * Phase 7C rules:
 * - EXISTENCE authorization matches today's computeCanSkip() exactly.
 * - GRAPH / CONTRACT / SEMANTIC are recorded as passive (no policy effect).
 * - Does not mutate TRUST_POLICY, executors, or package generation.
 */

const {
    computeCanSkip,
    CAPABILITY_IDS,
    CAPABILITY_STATUS
} = require('../deploymentPlannerCompatibility/deploymentPlannerCompatibility.analyzer.service');

/** Capabilities that may influence Skip authorization in this phase. */
const ACTIVE_AUTHORIZATION_CAPABILITIES = Object.freeze([
    CAPABILITY_IDS.EXISTENCE
]);

/** Capabilities observed but ignored by policy in Phase 7C. */
const PASSIVE_AUTHORIZATION_CAPABILITIES = Object.freeze([
    CAPABILITY_IDS.GRAPH,
    CAPABILITY_IDS.CONTRACT,
    CAPABILITY_IDS.SEMANTIC
]);

function getCapabilityStatus(capabilities, capabilityId) {
    const entry = capabilities?.[capabilityId];

    if (!entry || typeof entry !== 'object') {
        return null;
    }

    return entry.status || null;
}

/**
 * Authorize planner Skip using trusted capabilities + capability facts.
 *
 * Phase 7C: only EXISTENCE is active; canSkip is identical to computeCanSkip().
 *
 * @param {object} [params]
 * @param {string[]} [params.trustedCapabilities]
 * @param {object|null} [params.capabilities]
 * @param {string|null} [params.destinationState]
 * @param {string|null} [params.analysisLevel]
 * @returns {{
 *   canSkip: boolean,
 *   authorized: boolean,
 *   reasons: string[],
 *   trace: object
 * }}
 */
function authorizeCapabilities({
    trustedCapabilities = [],
    capabilities = null,
    destinationState = null,
    analysisLevel = null
} = {}) {
    const trusted = Array.isArray(trustedCapabilities)
        ? [...trustedCapabilities]
        : [];
    const caps =
        capabilities && typeof capabilities === 'object' ? capabilities : {};

    // Phase 7C — EXISTENCE Skip policy identical to today's computeCanSkip.
    const canSkip = computeCanSkip({
        destinationState,
        analysisLevel
    });

    const reasons = [];
    const evaluated = [];

    if (!analysisLevel || analysisLevel === 'NONE') {
        reasons.push(
            'EXISTENCE policy: analysisLevel NONE; Skip capability denied.'
        );
    } else if (analysisLevel !== 'EXISTENCE') {
        reasons.push(
            `EXISTENCE policy: analysisLevel ${analysisLevel} does not authorize Skip (Phase 7C).`
        );
    } else if (destinationState === 'EXISTS') {
        reasons.push(
            'EXISTENCE policy: destination EXISTS; Skip capability granted.'
        );
    } else {
        reasons.push(
            'EXISTENCE policy: destination is not EXISTS; Skip capability denied.'
        );
    }

    evaluated.push({
        capability: CAPABILITY_IDS.EXISTENCE,
        role: 'ACTIVE',
        status:
            getCapabilityStatus(caps, CAPABILITY_IDS.EXISTENCE) ||
            (destinationState === 'EXISTS'
                ? CAPABILITY_STATUS.PASS
                : destinationState === 'MISSING'
                  ? CAPABILITY_STATUS.FAIL
                  : CAPABILITY_STATUS.UNKNOWN),
        trusted: trusted.includes(CAPABILITY_IDS.EXISTENCE),
        contributedToCanSkip: canSkip === true
    });

    const passiveCapabilities = [];

    for (const capabilityId of PASSIVE_AUTHORIZATION_CAPABILITIES) {
        const status = getCapabilityStatus(caps, capabilityId);
        const isTrusted = trusted.includes(capabilityId);

        if (status == null && !isTrusted) {
            continue;
        }

        passiveCapabilities.push(capabilityId);
        evaluated.push({
            capability: capabilityId,
            role: 'PASSIVE',
            status: status || CAPABILITY_STATUS.NOT_EVALUATED,
            trusted: isTrusted,
            contributedToCanSkip: false
        });

        if (isTrusted) {
            reasons.push(
                `${capabilityId} is trusted but remains passive in Phase 7C authorization.`
            );
        }
    }

    const activeTrusted = trusted.filter((capabilityId) =>
        ACTIVE_AUTHORIZATION_CAPABILITIES.includes(capabilityId)
    );

    return {
        // Phase 7C: Skip capability bit — identical to computeCanSkip().
        canSkip,
        // Phase 7C: policy authorization mirrors canSkip while only EXISTENCE is active.
        authorized: canSkip,
        reasons,
        trace: {
            phase: '7C',
            trustedCapabilities: trusted,
            activeTrustedCapabilities: activeTrusted,
            activeCapabilities: [...ACTIVE_AUTHORIZATION_CAPABILITIES],
            passiveCapabilities,
            analysisLevel: analysisLevel || null,
            destinationState: destinationState || null,
            evaluated
        }
    };
}

module.exports = {
    ACTIVE_AUTHORIZATION_CAPABILITIES,
    PASSIVE_AUTHORIZATION_CAPABILITIES,
    authorizeCapabilities
};
