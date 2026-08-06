/**
 * TEMPORARY DEBUG ONLY — Phase 13.5 Metadata API Adoption Trace.
 * Remove after the adoption reconciliation investigation is complete.
 * Logging only; never changes negotiation, compatibility, package, workspace,
 * or CLI behavior.
 */

const TRACED_CATEGORIES = Object.freeze([
    'FORMULA_TYPE_CHANGE',
    'FORMULA_COMPILATION',
    'FLOW_API_VERSION',
    'PERMISSION_SET_API_VERSION'
]);

const state = createEmptyState();

function createEmptyState() {
    return {
        currentDeploymentApi: null,
        sourceApi: null,
        destinationApi: null,
        negotiatedApi: null,
        effectiveCompatibilityApi: null,
        negotiationStatus: null,
        adoptedDeploymentApi: null,
        plannerApi: null,
        packageApi: null,
        packageXmlVersion: null,
        workspaceApi: null,
        cliApi: null,
        cliCommand: null
    };
}

function value(input) {
    return input === null || input === undefined || input === ''
        ? '(unknown)'
        : String(input);
}

function normalize(input) {
    const match = String(input ?? '')
        .trim()
        .match(/^(\d+)(?:\.(\d+))?/);

    return match ? `${match[1]}.${match[2] || '0'}` : null;
}

function banner(title) {
    console.log('=====================================');
    console.log(title);
    console.log('=====================================');
}

function beginAdoptionTrace() {
    Object.assign(state, createEmptyState());
}

/** Stage 1 — immediately after negotiation. */
function logNegotiationStage({
    currentDeploymentApiVersion = null,
    sourceApiVersion = null,
    destinationApiVersion = null,
    negotiatedApiVersion = null,
    effectiveCompatibilityApiVersion = null,
    negotiationStatus = null,
    adoptedDeploymentApiVersion = null
} = {}) {
    state.currentDeploymentApi = normalize(currentDeploymentApiVersion);
    state.sourceApi = normalize(sourceApiVersion);
    state.destinationApi = normalize(destinationApiVersion);
    state.negotiatedApi = normalize(negotiatedApiVersion);
    state.effectiveCompatibilityApi = normalize(
        effectiveCompatibilityApiVersion
    );
    state.negotiationStatus = negotiationStatus || null;
    state.adoptedDeploymentApi = normalize(adoptedDeploymentApiVersion);

    banner('METADATA API ADOPTION TRACE — STAGE 1 NEGOTIATION');
    console.log('Current Deployment API:', value(state.currentDeploymentApi));
    console.log('Source API:', value(state.sourceApi));
    console.log('Destination API:', value(state.destinationApi));
    console.log('Negotiated API:', value(state.negotiatedApi));
    console.log(
        'Effective Compatibility API:',
        value(state.effectiveCompatibilityApi)
    );
    console.log('Negotiation Status:', value(state.negotiationStatus));
    console.log('Adopted Deployment API:', value(state.adoptedDeploymentApi));
    console.log('=====================================');
}

/** Stage 2 — immediately before the compatibility planner. */
function logPlannerInputStage({
    plannerApiVersion = null,
    effectiveCompatibilityApiVersion = null,
    negotiatedApiVersion = null
} = {}) {
    state.plannerApi = normalize(plannerApiVersion);

    banner('METADATA API ADOPTION TRACE — STAGE 2 PLANNER INPUT');
    console.log('API version received by planner:', value(state.plannerApi));
    console.log(
        'Compatibility API:',
        value(normalize(effectiveCompatibilityApiVersion))
    );
    console.log('Negotiated API:', value(normalize(negotiatedApiVersion)));
    console.log('=====================================');
}

/** Stage 3 — inside the compatibility planner, per category. */
function logPlannerEvaluationStage({
    deploymentApiVersion = null,
    compatibilityWarnings = []
} = {}) {
    const traced = (
        Array.isArray(compatibilityWarnings) ? compatibilityWarnings : []
    ).filter((warning) => TRACED_CATEGORIES.includes(warning?.category));

    banner('METADATA API ADOPTION TRACE — STAGE 3 PLANNER EVALUATION');
    console.log(
        'Planner evaluated API version:',
        value(normalize(deploymentApiVersion))
    );
    console.log(
        traced.length
            ? traced.map((warning) => ({
                  category: warning.category,
                  metadataName: warning.metadataName || null,
                  evaluatedApiVersion:
                      warning.currentApi ||
                      normalize(deploymentApiVersion) ||
                      null,
                  requiredApiVersion: warning.requiredApi || null,
                  reason: warning.message || null
              }))
            : ['(no Formula / Flow / PermissionSet findings)']
    );
    console.log('=====================================');
}

/** Stage 4 — immediately before package (manifest) generation. */
function logPackageStage({ packageApiVersion = null } = {}) {
    state.packageApi = normalize(packageApiVersion);

    banner('METADATA API ADOPTION TRACE — STAGE 4 PACKAGE');
    console.log('Package API version:', value(state.packageApi));
    console.log('=====================================');
}

/** Stage 5 — immediately after package.xml generation. */
function logManifestStage({ packageXml = null, manifestSummary = null } = {}) {
    const versionMatch = String(packageXml || '').match(
        /<version>\s*([^<]+?)\s*<\/version>/
    );

    state.packageXmlVersion =
        normalize(versionMatch?.[1]) || normalize(manifestSummary?.apiVersion);

    banner('METADATA API ADOPTION TRACE — STAGE 5 PACKAGE.XML');
    console.log(packageXml || '(empty package.xml)');
    console.log('-------------------------------------');
    console.log('<version>:', value(state.packageXmlVersion));
    console.log('=====================================');
}

/** Stage 6 — immediately before workspace generation. */
function logWorkspaceStage({ deploymentApiVersion = null } = {}) {
    state.workspaceApi = normalize(deploymentApiVersion);

    banner('METADATA API ADOPTION TRACE — STAGE 6 WORKSPACE');
    console.log('Deployment API:', value(state.workspaceApi));
    console.log('=====================================');
}

/** Stage 7 — immediately before the Salesforce CLI deploy. */
function logCliStage({ deploymentApiVersion = null, cliCommand = null } = {}) {
    state.cliApi = normalize(deploymentApiVersion);
    state.cliCommand = cliCommand || null;

    banner('METADATA API ADOPTION TRACE — STAGE 7 CLI');
    console.log('Resolved API version:', value(state.cliApi));
    console.log('CLI command:', value(state.cliCommand));
    console.log('=====================================');
}

/** Stage 8 — immediately after CLI command creation. */
function logCliCommandStage({ cliCommand = null } = {}) {
    const command = cliCommand || state.cliCommand || '';
    const apiVersionMatch = command.match(/--api-version\s+"?([^"\s]+)"?/);
    const flags = command.match(/--[\w-]+(?:\s+"[^"]*"|\s+[^\s-][^\s]*)?/g);

    if (apiVersionMatch) {
        state.cliApi = normalize(apiVersionMatch[1]);
    }

    state.cliCommand = command || null;

    banner('METADATA API ADOPTION TRACE — STAGE 8 CLI ARGUMENTS');
    console.log(flags && flags.length ? flags : ['(no CLI flags parsed)']);
    console.log(
        '--api-version:',
        apiVersionMatch ? value(state.cliApi) : '(flag not present)'
    );
    console.log('=====================================');
}

/**
 * First stage whose API version differs from the negotiated API. Stages that
 * never ran are skipped so partial runs still report a usable answer.
 */
function resolveFirstStageLosingNegotiatedApi() {
    if (!state.negotiatedApi) {
        return 'Negotiation (negotiated API never established)';
    }

    const stages = [
        ['Planner', state.plannerApi],
        ['Package', state.packageApi],
        ['package.xml', state.packageXmlVersion],
        ['Workspace', state.workspaceApi],
        ['CLI', state.cliApi]
    ];

    for (const [name, version] of stages) {
        if (version && version !== state.negotiatedApi) {
            return name;
        }
    }

    return 'None';
}

function logAdoptionReport() {
    console.log('==================================================');
    console.log('METADATA API ADOPTION REPORT');
    console.log('==================================================');
    console.log('Current Deployment API:', value(state.currentDeploymentApi));
    console.log('Source API:', value(state.sourceApi));
    console.log('Destination API:', value(state.destinationApi));
    console.log('Negotiated API:', value(state.negotiatedApi));
    console.log(
        'Effective Compatibility API:',
        value(state.effectiveCompatibilityApi)
    );
    console.log('Planner API:', value(state.plannerApi));
    console.log('Package API:', value(state.packageApi));
    console.log('package.xml Version:', value(state.packageXmlVersion));
    console.log('Workspace API:', value(state.workspaceApi));
    console.log('CLI API:', value(state.cliApi));
    console.log('--------------------------------------------------');
    console.log(
        'First Stage Losing Negotiated API:',
        resolveFirstStageLosingNegotiatedApi()
    );
    console.log('==================================================');
}

function getAdoptionTraceState() {
    return { ...state };
}

module.exports = {
    TRACED_CATEGORIES,
    beginAdoptionTrace,
    logNegotiationStage,
    logPlannerInputStage,
    logPlannerEvaluationStage,
    logPackageStage,
    logManifestStage,
    logWorkspaceStage,
    logCliStage,
    logCliCommandStage,
    resolveFirstStageLosingNegotiatedApi,
    logAdoptionReport,
    getAdoptionTraceState
};
