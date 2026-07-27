/**
 * Planner Authorization Framework — Phase 7C / 8B / 8D / 8F / 9F.
 *
 * Separates policy (authorization) from analyzer facts (capabilities).
 *
 * Phase 7C rules:
 * - EXISTENCE authorization matches today's computeCanSkip() exactly.
 * - Does not mutate TRUST_POLICY or package generation.
 *
 * Phase 8B (report-only):
 * - CustomObject GRAPH trust shadow: authorize as if trusted ['EXISTENCE','GRAPH'].
 * - Shadow never drives planner / package / executors.
 *
 * Phase 8D:
 * - GRAPH is an active capability when included in trustedCapabilities.
 * - Trusted EXISTENCE + GRAPH → AND policy (GRAPH PASS required).
 *
 * Phase 8F:
 * - availability GRANTED | DENIED | UNAVAILABLE for executor enforcement.
 * - DENIED = trusted policy evaluated and Skip not authorized.
 * - UNAVAILABLE = no active trusted capabilities (Legacy may apply).
 *
 * Phase 9D (report-only):
 * - CustomField CONTRACT trust shadow: EXISTENCE AND GRAPH AND CONTRACT.
 *
 * Phase 9F:
 * - CONTRACT is an active capability when included in trustedCapabilities.
 * - Trusted CONTRACT → PASS required (FAIL / UNKNOWN / DEFERRED / NOT_EVALUATED deny).
 * - TRUST_POLICY unchanged (CustomField still []); no production behavior change.
 */

const {
    computeCanSkip,
    CAPABILITY_IDS,
    CAPABILITY_STATUS
} = require('../deploymentPlannerCompatibility/deploymentPlannerCompatibility.analyzer.service');

/**
 * Capabilities that may influence Skip authorization when trusted.
 * GRAPH is active only when requested via trustedCapabilities (Phase 8D).
 * CONTRACT is active only when requested via trustedCapabilities (Phase 9F).
 */
const ACTIVE_AUTHORIZATION_CAPABILITIES = Object.freeze([
    CAPABILITY_IDS.EXISTENCE,
    CAPABILITY_IDS.GRAPH,
    CAPABILITY_IDS.CONTRACT
]);

/** Capabilities observed but ignored by policy unless later activated. */
const PASSIVE_AUTHORIZATION_CAPABILITIES = Object.freeze([
    CAPABILITY_IDS.SEMANTIC
]);

/** Phase 8F — executor uses availability to decide Legacy fallback. */
const AUTHORIZATION_AVAILABILITY = Object.freeze({
    GRANTED: 'GRANTED',
    DENIED: 'DENIED',
    UNAVAILABLE: 'UNAVAILABLE'
});

function getCapabilityStatus(capabilities, capabilityId) {
    const entry = capabilities?.[capabilityId];

    if (!entry || typeof entry !== 'object') {
        return null;
    }

    return entry.status || null;
}

function isAuthorizationCapabilityReady(
    capabilities,
    capabilityId,
    fallback = true
) {
    const entry = capabilities?.[capabilityId];

    if (!entry || typeof entry !== 'object') {
        return fallback === true;
    }

    if (typeof entry.authorizationReady === 'boolean') {
        return entry.authorizationReady === true;
    }

    return fallback === true;
}

function resolveExistenceStatus(capabilities, destinationState) {
    return (
        getCapabilityStatus(capabilities, CAPABILITY_IDS.EXISTENCE) ||
        (destinationState === 'EXISTS'
            ? CAPABILITY_STATUS.PASS
            : destinationState === 'MISSING'
              ? CAPABILITY_STATUS.FAIL
              : CAPABILITY_STATUS.UNKNOWN)
    );
}

function resolveGraphStatus(capabilities) {
    return (
        getCapabilityStatus(capabilities, CAPABILITY_IDS.GRAPH) ||
        CAPABILITY_STATUS.NOT_EVALUATED
    );
}

function resolveContractStatus(capabilities) {
    return (
        getCapabilityStatus(capabilities, CAPABILITY_IDS.CONTRACT) ||
        CAPABILITY_STATUS.NOT_EVALUATED
    );
}

/**
 * Authorize planner Skip using trusted capabilities + capability facts.
 *
 * - Trusted EXISTENCE only → canSkip/authorized identical to computeCanSkip().
 * - Trusted EXISTENCE + GRAPH → AND; GRAPH must be PASS (Phase 8D).
 * - Trusted CONTRACT → AND; CONTRACT must be PASS (Phase 9F).
 * - GRAPH/CONTRACT FAIL / UNKNOWN / DEFERRED / NOT_EVALUATED → authorization denied.
 * - Phase 8F availability: GRANTED | DENIED | UNAVAILABLE.
 *
 * @param {object} [params]
 * @param {string[]} [params.trustedCapabilities]
 * @param {object|null} [params.capabilities]
 * @param {string|null} [params.destinationState]
 * @param {string|null} [params.analysisLevel]
 * @returns {{
 *   canSkip: boolean,
 *   authorized: boolean,
 *   availability: string,
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
    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    console.log('\n==============================');
    console.log('AUTHORIZATION DEBUG');
    console.log('==============================');

    console.log({
        destinationState,
        trustPolicy: trustedCapabilities,
        analysisLevel
    });

    const trusted = Array.isArray(trustedCapabilities)
        ? [...trustedCapabilities]
        : [];
    const caps =
        capabilities && typeof capabilities === 'object' ? capabilities : {};

    const existenceTrusted = trusted.includes(CAPABILITY_IDS.EXISTENCE);
    const graphTrusted = trusted.includes(CAPABILITY_IDS.GRAPH);
    const contractTrusted = trusted.includes(CAPABILITY_IDS.CONTRACT);
    const graphReady = graphTrusted
        ? isAuthorizationCapabilityReady(caps, CAPABILITY_IDS.GRAPH, true)
        : false;
    const contractReady = contractTrusted
        ? isAuthorizationCapabilityReady(caps, CAPABILITY_IDS.CONTRACT, true)
        : false;

    // EXISTENCE Skip policy identical to today's computeCanSkip.
    const existenceOk = computeCanSkip({
        destinationState,
        analysisLevel
    });

    const existenceStatus = resolveExistenceStatus(caps, destinationState);
    const graphStatus = resolveGraphStatus(caps);
    const graphPass = graphStatus === CAPABILITY_STATUS.PASS;
    const contractStatus = resolveContractStatus(caps);
    const contractPass = contractStatus === CAPABILITY_STATUS.PASS;

    const reasons = [];
    const evaluated = [];
    const passiveCapabilities = [];

    if (!analysisLevel || analysisLevel === 'NONE') {
        reasons.push(
            'EXISTENCE policy: analysisLevel NONE; Skip capability denied.'
        );
    } else if (analysisLevel !== 'EXISTENCE') {
        reasons.push(
            `EXISTENCE policy: analysisLevel ${analysisLevel} does not authorize Skip.`
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
        status: existenceStatus,
        trusted: existenceTrusted,
        contributedToCanSkip: existenceOk === true
    });

    let graphContributed = false;

    if (graphTrusted && !graphReady) {
        reasons.push(
            'GRAPH policy: capability deferred for current phase; authorization gate inactive.'
        );
        evaluated.push({
            capability: CAPABILITY_IDS.GRAPH,
            role: 'DEFERRED',
            status: graphStatus,
            trusted: true,
            contributedToCanSkip: false
        });
    } else if (graphTrusted) {
        // Phase 8D — GRAPH is active when trusted; PASS required.
        if (graphPass) {
            reasons.push('GRAPH policy: status PASS; capability granted.');
            graphContributed = true;
        } else {
            const graphReason =
                caps[CAPABILITY_IDS.GRAPH]?.reason ||
                `status=${graphStatus}`;
            reasons.push(
                `GRAPH policy: authorization denied (status=${graphStatus}); ${graphReason}`
            );
        }

        evaluated.push({
            capability: CAPABILITY_IDS.GRAPH,
            role: 'ACTIVE',
            status: graphStatus,
            trusted: true,
            contributedToCanSkip: graphContributed
        });
    } else {
        // GRAPH not trusted — record passively when status is present.
        const status = getCapabilityStatus(caps, CAPABILITY_IDS.GRAPH);

        if (status != null) {
            passiveCapabilities.push(CAPABILITY_IDS.GRAPH);
            evaluated.push({
                capability: CAPABILITY_IDS.GRAPH,
                role: 'PASSIVE',
                status,
                trusted: false,
                contributedToCanSkip: false
            });
        }
    }

    let contractContributed = false;

    if (contractTrusted && !contractReady) {
        reasons.push(
            'CONTRACT policy: capability deferred for current phase; authorization gate inactive.'
        );
        evaluated.push({
            capability: CAPABILITY_IDS.CONTRACT,
            role: 'DEFERRED',
            status: contractStatus,
            trusted: true,
            contributedToCanSkip: false
        });
    } else if (contractTrusted) {
        // Phase 9F — CONTRACT is active when trusted; PASS required.
        if (contractPass) {
            reasons.push('CONTRACT policy: status PASS; capability granted.');
            contractContributed = true;
        } else {
            const contractReason =
                caps[CAPABILITY_IDS.CONTRACT]?.reason ||
                `status=${contractStatus}`;
            reasons.push(
                `CONTRACT policy: authorization denied (status=${contractStatus}); ${contractReason}`
            );
        }

        evaluated.push({
            capability: CAPABILITY_IDS.CONTRACT,
            role: 'ACTIVE',
            status: contractStatus,
            trusted: true,
            contributedToCanSkip: contractContributed
        });
    } else {
        // CONTRACT not trusted — record passively when status is present.
        const status = getCapabilityStatus(caps, CAPABILITY_IDS.CONTRACT);

        if (status != null) {
            passiveCapabilities.push(CAPABILITY_IDS.CONTRACT);
            evaluated.push({
                capability: CAPABILITY_IDS.CONTRACT,
                role: 'PASSIVE',
                status,
                trusted: false,
                contributedToCanSkip: false
            });
        }
    }

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
                `${capabilityId} is trusted but remains passive in authorization.`
            );
        }
    }

    // EXISTENCE-only trust (or empty trust): authorized mirrors existenceOk.
    // EXISTENCE + GRAPH and/or CONTRACT trust: each trusted capability must PASS.
    let authorized = existenceOk === true;

    if (graphTrusted && graphReady) {
        authorized = authorized && graphPass === true;
    }

    if (contractTrusted && contractReady) {
        authorized = authorized && contractPass === true;
    }

    const activeTrusted = trusted.filter((capabilityId) =>
        ACTIVE_AUTHORIZATION_CAPABILITIES.includes(capabilityId) &&
        (capabilityId === CAPABILITY_IDS.EXISTENCE ||
            isAuthorizationCapabilityReady(caps, capabilityId, true))
    );

    // Phase 8F — availability for enforcement (DENIED never falls back to Legacy).
    let availability = AUTHORIZATION_AVAILABILITY.UNAVAILABLE;

    if (activeTrusted.length === 0) {
        availability = AUTHORIZATION_AVAILABILITY.UNAVAILABLE;
        reasons.push(
            'Authorization UNAVAILABLE: no active trusted capabilities for this type.'
        );
    } else if (authorized) {
        availability = AUTHORIZATION_AVAILABILITY.GRANTED;
        if (
            graphTrusted &&
            contractTrusted &&
            existenceOk &&
            graphPass &&
            contractPass
        ) {
            reasons.push(
                'Authorization GRANTED (trusted EXISTENCE AND GRAPH AND CONTRACT all PASS).'
            );
        } else if (graphTrusted && existenceOk && graphPass) {
            reasons.push(
                'Authorization GRANTED (trusted EXISTENCE AND GRAPH both PASS).'
            );
        } else if (contractTrusted && existenceOk && contractPass) {
            reasons.push(
                'Authorization GRANTED (trusted EXISTENCE AND CONTRACT both PASS).'
            );
        } else {
            reasons.push(
                'Authorization GRANTED under trusted capability policy.'
            );
        }
    } else {
        availability = AUTHORIZATION_AVAILABILITY.DENIED;
        if (!existenceOk) {
            reasons.push('Authorization DENIED: EXISTENCE capability failed.');
        }
        if (graphTrusted && graphReady && !graphPass) {
            reasons.push('Authorization DENIED: GRAPH capability failed.');
        }
        if (contractTrusted && contractReady && !contractPass) {
            reasons.push('Authorization DENIED: CONTRACT capability failed.');
        }
        if (existenceOk && !graphTrusted && !contractTrusted) {
            reasons.push(
                'Authorization DENIED: trusted policy did not grant Skip.'
            );
        }
    }

    // TEMPORARY DEBUG — remove after Skip destinationState investigation.
    console.log({
        authorized,
        availability,
        reason: reasons
    });

    return {
        canSkip: authorized,
        authorized,
        availability,
        reasons,
        trace: {
            phase: '8F',
            trustedCapabilities: trusted,
            activeTrustedCapabilities: activeTrusted,
            activeCapabilities: [...ACTIVE_AUTHORIZATION_CAPABILITIES],
            passiveCapabilities,
            analysisLevel: analysisLevel || null,
            destinationState: destinationState || null,
            graphTrusted,
            contractTrusted,
            availability,
            evaluated
        }
    };
}

/**
 * Phase 8B — shadow authorization as if TRUST_POLICY were ['EXISTENCE','GRAPH'].
 * Report-only. Delegates to authorizeCapabilities so shadow equals active policy
 * when GRAPH is eventually trusted (Phase 8D).
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
    const authorization = authorizeCapabilities({
        trustedCapabilities: [
            CAPABILITY_IDS.EXISTENCE,
            CAPABILITY_IDS.GRAPH
        ],
        capabilities,
        destinationState,
        analysisLevel
    });

    return {
        ...authorization,
        trace: {
            ...authorization.trace,
            mode: 'SHADOW'
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
                    /GRAPH.*(denied|failed)/i.test(reason)
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

/**
 * Phase 9D — shadow authorization as if TRUST_POLICY were
 * ['EXISTENCE','GRAPH','CONTRACT'].
 * Report-only. Delegates to authorizeCapabilities so shadow equals active
 * policy when CONTRACT is eventually trusted (Phase 9F).
 *
 * @param {object} [params]
 * @param {object|null} [params.capabilities]
 * @param {string|null} [params.destinationState]
 * @param {string|null} [params.analysisLevel]
 * @returns {{
 *   canSkip: boolean,
 *   authorized: boolean,
 *   availability: string,
 *   reasons: string[],
 *   trace: object
 * }}
 */
function authorizeExistenceGraphAndContractShadow({
    capabilities = null,
    destinationState = null,
    analysisLevel = null
} = {}) {
    const caps =
        capabilities && typeof capabilities === 'object' ? capabilities : {};

    const authorization = authorizeCapabilities({
        trustedCapabilities: [
            CAPABILITY_IDS.EXISTENCE,
            CAPABILITY_IDS.GRAPH,
            CAPABILITY_IDS.CONTRACT
        ],
        capabilities: caps,
        destinationState,
        analysisLevel
    });

    const contractStatus =
        getCapabilityStatus(caps, CAPABILITY_IDS.CONTRACT) ||
        CAPABILITY_STATUS.NOT_EVALUATED;
    const contractPass = contractStatus === CAPABILITY_STATUS.PASS;

    return {
        ...authorization,
        trace: {
            ...authorization.trace,
            phase: '9D',
            mode: 'SHADOW',
            shadowedTrust: [
                CAPABILITY_IDS.EXISTENCE,
                CAPABILITY_IDS.GRAPH,
                CAPABILITY_IDS.CONTRACT
            ],
            contractStatus,
            contractPass
        }
    };
}

/**
 * Phase 9D — compare today's runtime authorization vs EXISTENCE+GRAPH+CONTRACT shadow.
 * CustomField only. Never used for planner decisions.
 *
 * @param {object} [params]
 * @param {object|null} [params.capabilities]
 * @param {string|null} [params.destinationState]
 * @param {string|null} [params.analysisLevel]
 * @param {boolean|null} [params.existsInDestination]
 * @returns {object}
 */
function buildCustomFieldContractTrustShadowComparison({
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

    // Today's TRUST_POLICY.CustomField = [] — EXISTENCE canSkip still computed.
    const runtimeAuth = authorizeCapabilities({
        trustedCapabilities: [],
        capabilities,
        destinationState: resolvedDestinationState,
        analysisLevel: resolvedAnalysisLevel
    });

    const shadowAuth = authorizeExistenceGraphAndContractShadow({
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
                    /CONTRACT.*(denied|failed)/i.test(reason)
                ) ||
                shadowAuth.reasons.find((reason) =>
                    /GRAPH.*(denied|failed)/i.test(reason)
                ) ||
                shadowAuth.reasons.join(' ') ||
                'Shadow denied Skip; runtime allowed Skip.';
        } else if (
            runtimeDecision === 'Deploy' &&
            shadowDecision === 'Skip'
        ) {
            differenceReason =
                'Shadow would allow Skip (EXISTENCE+GRAPH+CONTRACT PASS) while runtime requires Deploy.';
        } else {
            differenceReason = shadowAuth.reasons.join(' ');
        }
    }

    return {
        shadowAuthorized: shadowAuth.authorized,
        shadowReasons: shadowAuth.reasons,
        shadowTrace: shadowAuth.trace,
        contractTrustShadow: {
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
 * Phase 9D — attach CustomField-only CONTRACT trust shadow comparison.
 * Never mutates runtime authorization used by the planner.
 *
 * @param {object|null} plannerCompatibilityReport
 * @returns {object|null}
 */
function attachCustomFieldContractTrustShadow(plannerCompatibilityReport) {
    const results = plannerCompatibilityReport?.plannerCompatibility?.results;

    if (!Array.isArray(results)) {
        return plannerCompatibilityReport;
    }

    let compared = 0;
    let differences = 0;
    const sampleDifferences = [];

    const shadowedResults = results.map((row) => {
        if (row?.metadataType !== 'CustomField') {
            return row;
        }

        compared += 1;

        const comparison = buildCustomFieldContractTrustShadowComparison({
            capabilities: row.capabilities || null,
            destinationState:
                row.capabilities?.EXISTENCE?.evidence?.destinationState ||
                null,
            analysisLevel: row.analysisLevel || null,
            existsInDestination: row.existsInDestination
        });

        if (comparison.contractTrustShadow.decisionDifference) {
            differences += 1;

            if (sampleDifferences.length < 10) {
                sampleDifferences.push({
                    metadataType: row.metadataType,
                    metadataName: row.metadataName,
                    runtimeDecision:
                        comparison.contractTrustShadow.runtimeDecision,
                    shadowDecision:
                        comparison.contractTrustShadow.shadowDecision,
                    differenceReason:
                        comparison.contractTrustShadow.differenceReason
                });
            }
        }

        return {
            ...row,
            shadowAuthorized: comparison.shadowAuthorized,
            shadowReasons: comparison.shadowReasons,
            shadowTrace: comparison.shadowTrace,
            contractTrustShadow: comparison.contractTrustShadow
        };
    });

    return {
        plannerCompatibility: {
            ...plannerCompatibilityReport.plannerCompatibility,
            results: shadowedResults,
            contractTrustShadowSummary: {
                phase: '9D',
                metadataType: 'CustomField',
                shadowedTrust: ['EXISTENCE', 'GRAPH', 'CONTRACT'],
                compared,
                differences,
                sampleDifferences,
                runtimeTrustUnchanged: true,
                contractTrustEnabled: false
            }
        }
    };
}

module.exports = {
    ACTIVE_AUTHORIZATION_CAPABILITIES,
    PASSIVE_AUTHORIZATION_CAPABILITIES,
    AUTHORIZATION_AVAILABILITY,
    authorizeCapabilities,
    authorizeExistenceAndGraphShadow,
    authorizeExistenceGraphAndContractShadow,
    buildCustomObjectGraphTrustShadowComparison,
    buildCustomFieldContractTrustShadowComparison,
    attachCustomObjectGraphTrustShadow,
    attachCustomFieldContractTrustShadow
};
