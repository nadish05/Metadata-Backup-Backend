/**
 * Planner Authorization Framework — Phase 7C / 8B.
 *
 * Separates policy (authorization) from analyzer facts (capabilities).
 *
 * Phase 7C rules:
 * - EXISTENCE authorization matches today's computeCanSkip() exactly.
 * - GRAPH / CONTRACT / SEMANTIC are recorded as passive (no policy effect).
 * - Does not mutate TRUST_POLICY, executors, or package generation.
 *
 * Phase 8B (report-only):
 * - CustomObject GRAPH trust shadow: authorize as if trusted ['EXISTENCE','GRAPH'].
 * - Shadow never drives planner / package / executors.
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

/**
 * Phase 8B — shadow authorization as if TRUST_POLICY were ['EXISTENCE','GRAPH'].
 * Report-only. Does not affect runtime authorizeCapabilities() / TRUST_POLICY.
 *
 * Policy: Skip authorized only when EXISTENCE canSkip AND GRAPH PASS (AND).
 *
 * @param {object} [params]
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
function authorizeExistenceAndGraphShadow({
    capabilities = null,
    destinationState = null,
    analysisLevel = null
} = {}) {
    const caps =
        capabilities && typeof capabilities === 'object' ? capabilities : {};
    const trustedCapabilities = [
        CAPABILITY_IDS.EXISTENCE,
        CAPABILITY_IDS.GRAPH
    ];

    const existenceStatus =
        getCapabilityStatus(caps, CAPABILITY_IDS.EXISTENCE) ||
        (destinationState === 'EXISTS'
            ? CAPABILITY_STATUS.PASS
            : destinationState === 'MISSING'
              ? CAPABILITY_STATUS.FAIL
              : CAPABILITY_STATUS.UNKNOWN);

    const graphStatus =
        getCapabilityStatus(caps, CAPABILITY_IDS.GRAPH) ||
        CAPABILITY_STATUS.NOT_EVALUATED;

    // EXISTENCE half identical to today's runtime canSkip / authorizeCapabilities.
    const existenceOk = computeCanSkip({
        destinationState,
        analysisLevel
    });
    const graphPass = graphStatus === CAPABILITY_STATUS.PASS;
    const authorized = existenceOk === true && graphPass === true;

    const reasons = [];

    if (!existenceOk) {
        reasons.push(
            `EXISTENCE failed or incomplete (status=${existenceStatus}); Skip denied under shadow EXISTENCE+GRAPH.`
        );
    } else {
        reasons.push(
            'EXISTENCE passed under shadow EXISTENCE+GRAPH policy.'
        );
    }

    if (!graphPass) {
        const graphReason =
            caps[CAPABILITY_IDS.GRAPH]?.reason ||
            `GRAPH status=${graphStatus}`;
        reasons.push(
            `GRAPH failed under shadow EXISTENCE+GRAPH policy: ${graphReason}`
        );
    } else {
        reasons.push('GRAPH passed under shadow EXISTENCE+GRAPH policy.');
    }

    if (authorized) {
        reasons.push(
            'Shadow authorization granted (EXISTENCE AND GRAPH both PASS).'
        );
    } else {
        reasons.push(
            'Shadow authorization denied (require EXISTENCE AND GRAPH PASS).'
        );
    }

    return {
        canSkip: authorized,
        authorized,
        reasons,
        trace: {
            phase: '8B',
            mode: 'SHADOW',
            trustedCapabilities,
            activeTrustedCapabilities: trustedCapabilities,
            activeCapabilities: trustedCapabilities,
            passiveCapabilities: [],
            analysisLevel: analysisLevel || null,
            destinationState: destinationState || null,
            evaluated: [
                {
                    capability: CAPABILITY_IDS.EXISTENCE,
                    role: 'ACTIVE',
                    status: existenceStatus,
                    trusted: true,
                    contributedToCanSkip: existenceOk === true
                },
                {
                    capability: CAPABILITY_IDS.GRAPH,
                    role: 'ACTIVE',
                    status: graphStatus,
                    trusted: true,
                    contributedToCanSkip: graphPass === true
                }
            ]
        }
    };
}

/**
 * Phase 8B — compare today's runtime authorization vs EXISTENCE+GRAPH shadow.
 * CustomObject only. Never used for planner decisions.
 *
 * @param {object} [params]
 * @param {object|null} [params.capabilities]
 * @param {string|null} [params.destinationState]
 * @param {string|null} [params.analysisLevel]
 * @param {boolean|null} [params.existsInDestination]
 * @returns {object}
 */
function buildCustomObjectGraphTrustShadowComparison({
    capabilities = null,
    destinationState = null,
    analysisLevel = null,
    existsInDestination = null
} = {}) {
    const resolvedDestinationState =
        destinationState ||
        capabilities?.EXISTENCE?.evidence?.destinationState ||
        (existsInDestination === true
            ? 'EXISTS'
            : existsInDestination === false
              ? 'MISSING'
              : null);

    const resolvedAnalysisLevel =
        analysisLevel ||
        (resolvedDestinationState === 'EXISTS' ? 'EXISTENCE' : 'NONE');

    // Today's TRUST_POLICY.CustomObject = [] — EXISTENCE canSkip still computed.
    const runtimeAuth = authorizeCapabilities({
        trustedCapabilities: [],
        capabilities,
        destinationState: resolvedDestinationState,
        analysisLevel: resolvedAnalysisLevel
    });

    const shadowAuth = authorizeExistenceAndGraphShadow({
        capabilities,
        destinationState: resolvedDestinationState,
        analysisLevel: resolvedAnalysisLevel
    });

    const runtimeDecision = runtimeAuth.authorized ? 'Skip' : 'Deploy';
    const shadowDecision = shadowAuth.authorized ? 'Skip' : 'Deploy';
    const decisionDifference = runtimeDecision !== shadowDecision;

    let differenceReason = 'Both policies agree.';

    if (decisionDifference) {
        if (runtimeDecision === 'Skip' && shadowDecision === 'Deploy') {
            differenceReason =
                shadowAuth.reasons.find((reason) =>
                    /GRAPH failed/i.test(reason)
                ) ||
                shadowAuth.reasons.join(' ') ||
                'Shadow denied Skip; runtime allowed Skip.';
        } else if (
            runtimeDecision === 'Deploy' &&
            shadowDecision === 'Skip'
        ) {
            differenceReason =
                'Shadow would allow Skip (EXISTENCE+GRAPH PASS) while runtime requires Deploy.';
        } else {
            differenceReason = shadowAuth.reasons.join(' ');
        }
    }

    return {
        shadowAuthorized: shadowAuth.authorized,
        shadowReasons: shadowAuth.reasons,
        shadowTrace: shadowAuth.trace,
        graphTrustShadow: {
            runtimeAuthorized: runtimeAuth.authorized,
            runtimeDecision,
            shadowAuthorized: shadowAuth.authorized,
            shadowDecision,
            decisionDifference,
            differenceReason,
            runtimeReasons: runtimeAuth.reasons,
            shadowReasons: shadowAuth.reasons
        }
    };
}

/**
 * Phase 8B — attach CustomObject-only GRAPH trust shadow comparison.
 * Never mutates runtime authorization used by the planner.
 *
 * @param {object|null} plannerCompatibilityReport
 * @returns {object|null}
 */
function attachCustomObjectGraphTrustShadow(plannerCompatibilityReport) {
    const results = plannerCompatibilityReport?.plannerCompatibility?.results;

    if (!Array.isArray(results)) {
        return plannerCompatibilityReport;
    }

    let compared = 0;
    let differences = 0;
    const sampleDifferences = [];

    const shadowedResults = results.map((row) => {
        if (row?.metadataType !== 'CustomObject') {
            return row;
        }

        compared += 1;

        const comparison = buildCustomObjectGraphTrustShadowComparison({
            capabilities: row.capabilities || null,
            destinationState:
                row.capabilities?.EXISTENCE?.evidence?.destinationState ||
                null,
            analysisLevel: row.analysisLevel || null,
            existsInDestination: row.existsInDestination
        });

        if (comparison.graphTrustShadow.decisionDifference) {
            differences += 1;

            if (sampleDifferences.length < 10) {
                sampleDifferences.push({
                    metadataType: row.metadataType,
                    metadataName: row.metadataName,
                    runtimeDecision:
                        comparison.graphTrustShadow.runtimeDecision,
                    shadowDecision:
                        comparison.graphTrustShadow.shadowDecision,
                    differenceReason:
                        comparison.graphTrustShadow.differenceReason
                });
            }
        }

        return {
            ...row,
            shadowAuthorized: comparison.shadowAuthorized,
            shadowReasons: comparison.shadowReasons,
            shadowTrace: comparison.shadowTrace,
            graphTrustShadow: comparison.graphTrustShadow
        };
    });

    return {
        plannerCompatibility: {
            ...plannerCompatibilityReport.plannerCompatibility,
            results: shadowedResults,
            graphTrustShadowSummary: {
                phase: '8B',
                metadataType: 'CustomObject',
                shadowedTrust: ['EXISTENCE', 'GRAPH'],
                compared,
                differences,
                sampleDifferences,
                runtimeTrustUnchanged: true,
                graphTrustEnabled: false
            }
        }
    };
}

module.exports = {
    ACTIVE_AUTHORIZATION_CAPABILITIES,
    PASSIVE_AUTHORIZATION_CAPABILITIES,
    authorizeCapabilities,
    authorizeExistenceAndGraphShadow,
    buildCustomObjectGraphTrustShadowComparison,
    attachCustomObjectGraphTrustShadow
};
