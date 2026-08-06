/**
 * TEMPORARY DEBUG ONLY — Phase 13.5.1 Source API Discovery Trace.
 * Remove after the source Metadata API discovery investigation is complete.
 * Logging only; never changes discovery, negotiation, or deployment behavior.
 */

const state = createEmptyState();

function createEmptyState() {
    return {
        step1: null,
        step2: null,
        step3: null,
        step4: null,
        step5: null,
        step6: null,
        step7: null
    };
}

function yesNo(input) {
    return input === true ? 'YES' : 'NO';
}

function value(input) {
    return input === null || input === undefined || input === ''
        ? '(none)'
        : String(input);
}

function beginSourceApiDiscoveryTrace() {
    Object.assign(state, createEmptyState());
}

/** Step 1 — identifier available to deploymentValidation. */
function traceSourceOrgIdentifier({
    sourceOrgId = null,
    identifierField = null
} = {}) {
    state.step1 = {
        sourceOrgId,
        identifierField,
        present: Boolean(sourceOrgId)
    };
}

/** Step 2 — connected source org lookup. */
function traceSourceOrgLookup({
    lookupSource = null,
    connectedOrgFound = false,
    orgId = null,
    instanceUrl = null,
    refreshTokenPresent = false
} = {}) {
    state.step2 = {
        lookupSource,
        connectedOrgFound,
        orgId,
        instanceUrl,
        refreshTokenPresent
    };
}

/** Step 3 — source org authentication. */
function traceSourceAuthentication({
    accessTokenGenerated = false,
    authenticationError = null
} = {}) {
    state.step3 = {
        accessTokenGenerated,
        authenticationError
    };
}

/** Step 4 — Salesforce REST API version discovery. */
function traceApiDiscovery({
    executed = false,
    endpoint = null,
    httpStatus = null,
    responseBody = null
} = {}) {
    state.step4 = {
        executed,
        endpoint,
        httpStatus,
        responseBody
    };
}

/** Step 5 — resolved source Metadata API version. */
function traceResolvedSourceApi({ resolvedApiVersion = null } = {}) {
    state.step5 = {
        resolvedApiVersion: resolvedApiVersion || null
    };
}

/** Step 6 — persistence onto the deployment package. */
function traceSourceApiStored({ stored = false, storedValue = null } = {}) {
    state.step6 = {
        stored,
        storedValue
    };
}

/** Step 7 — values actually handed to negotiation. */
function traceNegotiationInput({
    sourceApiVersion = null,
    destinationApiVersion = null
} = {}) {
    state.step7 = {
        sourceApiVersion,
        destinationApiVersion
    };
}

/**
 * First step whose own success criterion failed. A missing Step 1 identifier is
 * only fatal when the Step 2 fallback lookup also failed.
 */
function resolveFirstFailure() {
    if (state.step2 && !state.step2.connectedOrgFound) {
        return state.step1 && !state.step1.present
            ? {
                  step: 'Step 1',
                  reason:
                      'deploymentValidation never receives a source org identifier, and the fallback connected-org lookup found no source org.'
              }
            : {
                  step: 'Step 2',
                  reason:
                      'No connected source org with both an instance URL and a refresh token was found.'
              };
    }

    if (state.step3 && !state.step3.accessTokenGenerated) {
        return {
            step: 'Step 3',
            reason:
                state.step3.authenticationError ||
                'Source org access token could not be generated.'
        };
    }

    if (state.step4 && !state.step4.executed) {
        return {
            step: 'Step 4',
            reason: 'Source API version endpoint was never executed.'
        };
    }

    if (state.step5 && !state.step5.resolvedApiVersion) {
        return {
            step: 'Step 5',
            reason: 'Source Metadata API version resolved to UNKNOWN.'
        };
    }

    if (state.step6 && !state.step6.stored) {
        return {
            step: 'Step 6',
            reason:
                'Resolved version was not stored into deploymentPackage.sourceApiVersion.'
        };
    }

    if (state.step7 && !state.step7.sourceApiVersion) {
        return {
            step: 'Step 7',
            reason: 'Negotiation received no source API version.'
        };
    }

    return {
        step: 'None',
        reason: 'Source Metadata API discovery completed end to end.'
    };
}

function logSourceApiDiscoveryTrace() {
    const firstFailure = resolveFirstFailure();

    console.log('====================================================');
    console.log('SOURCE API DISCOVERY TRACE');
    console.log('====================================================');
    console.log('');
    console.log('STEP 1');
    console.log('');
    console.log('deploymentValidation');
    console.log('');
    console.log('Source Org Id');
    console.log('');
    console.log('Value:');
    console.log(value(state.step1?.sourceOrgId));
    console.log('');
    console.log('Present:');
    console.log(yesNo(state.step1?.present));
    console.log('');
    console.log('----------------------------------------------------');
    console.log('');
    console.log('STEP 2');
    console.log('');
    console.log('Source Org lookup');
    console.log('');
    console.log('Connected Org found');
    console.log(yesNo(state.step2?.connectedOrgFound));
    console.log('');
    console.log('Org Id');
    console.log(value(state.step2?.orgId));
    console.log('');
    console.log('Instance URL');
    console.log(value(state.step2?.instanceUrl));
    console.log('');
    console.log('Refresh Token Present');
    console.log(yesNo(state.step2?.refreshTokenPresent));
    console.log('');
    console.log('Lookup Source');
    console.log(value(state.step2?.lookupSource));
    console.log('');
    console.log('----------------------------------------------------');
    console.log('');
    console.log('STEP 3');
    console.log('');
    console.log('Authentication');
    console.log('');
    console.log('Access Token Generated');
    console.log(yesNo(state.step3?.accessTokenGenerated));
    console.log('');
    console.log('Any authentication exception');
    console.log(value(state.step3?.authenticationError));
    console.log('');
    console.log('----------------------------------------------------');
    console.log('');
    console.log('STEP 4');
    console.log('');
    console.log('API Discovery');
    console.log('');
    console.log('REST endpoint executed');
    console.log(yesNo(state.step4?.executed));
    console.log('');
    console.log('Endpoint');
    console.log(value(state.step4?.endpoint));
    console.log('');
    console.log('HTTP Status');
    console.log(value(state.step4?.httpStatus));
    console.log('');
    console.log('Response body');
    console.log(value(state.step4?.responseBody));
    console.log('');
    console.log('----------------------------------------------------');
    console.log('');
    console.log('STEP 5');
    console.log('');
    console.log('Resolved Source Metadata API');
    console.log('');
    console.log(state.step5?.resolvedApiVersion || 'UNKNOWN');
    console.log('');
    console.log('----------------------------------------------------');
    console.log('');
    console.log('STEP 6');
    console.log('');
    console.log('Stored into');
    console.log('');
    console.log('deploymentPackage.sourceApiVersion');
    console.log('');
    console.log(yesNo(state.step6?.stored));
    console.log('');
    console.log('Value');
    console.log(value(state.step6?.storedValue));
    console.log('');
    console.log('----------------------------------------------------');
    console.log('');
    console.log('STEP 7');
    console.log('');
    console.log('Negotiation Input');
    console.log('');
    console.log('Source API');
    console.log(value(state.step7?.sourceApiVersion));
    console.log('');
    console.log('Destination API');
    console.log(value(state.step7?.destinationApiVersion));
    console.log('');
    console.log('----------------------------------------------------');
    console.log('');
    console.log('FIRST FAILURE');
    console.log('');
    console.log(firstFailure.step);
    console.log('');
    console.log('Reason');
    console.log(firstFailure.reason);
    console.log('');
    console.log('====================================================');
}

function getSourceApiDiscoveryTraceState() {
    return { ...state };
}

module.exports = {
    beginSourceApiDiscoveryTrace,
    traceSourceOrgIdentifier,
    traceSourceOrgLookup,
    traceSourceAuthentication,
    traceApiDiscovery,
    traceResolvedSourceApi,
    traceSourceApiStored,
    traceNegotiationInput,
    resolveFirstFailure,
    logSourceApiDiscoveryTrace,
    getSourceApiDiscoveryTraceState
};
