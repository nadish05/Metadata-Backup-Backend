/**
 * TEMPORARY DEBUG ONLY — Phase 13.5 Metadata API Adoption Reconciliation.
 *
 * Replays the exact production API-version chain offline (policy → negotiation
 * → adoption → planner → package.xml → CLI) so the trace report can identify
 * the first stage that loses the negotiated Metadata API version.
 * Remove together with metadataApiAdoptionTrace.temp.js.
 */

const assert = require('assert');

const {
    resolveDeploymentApiVersionPolicy
} = require('./deploymentApiVersionPolicy.service');
const {
    negotiateDeploymentApiVersionsSafe,
    resolveDeploymentApiVersion
} = require('./deploymentApiNegotiation.service');
const {
    analyzePermissionSetCompatibilitySafe
} = require('./deploymentPermissionSetCompatibility.service');
const {
    analyzeDeploymentCompatibilityPlan,
    CATEGORIES
} = require('./deploymentCompatibility.service');
const { generateManifest } = require('./packageXml.service');
const { buildProjectDeployCommand } = require('./checkOnlyDeployment.service');
const metadataApiAdoptionTrace = require('./metadataApiAdoptionTrace.temp');

const PERMISSION_SET_XML =
    '<PermissionSet><objectPermissions><object>Subscription__c</object>' +
    '<viewAllFields>true</viewAllFields></objectPermissions></PermissionSet>';

function packageWithPermissionSet() {
    return {
        metadata: [
            {
                metadataType: 'PermissionSet',
                metadataName: 'Subscription_Access',
                content: PERMISSION_SET_XML
            }
        ],
        dependencies: [],
        testClasses: []
    };
}

/**
 * Replays validateDeployment's API-version chain for one scenario and returns
 * the collected trace state.
 */
async function replayAdoptionChain({
    label,
    deploymentPackage = {},
    embeddedApiVersions = [],
    destinationMaxApiVersion = null
}) {
    console.log('##################################################');
    console.log('SCENARIO:', label);
    console.log('##################################################');

    const generatedDeploymentPackage = packageWithPermissionSet();

    const deploymentApiVersionPolicy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions,
        destinationMaxApiVersion
    });

    const deploymentApiNegotiation = negotiateDeploymentApiVersionsSafe({
        sourceApiVersion:
            deploymentPackage?.sourceApiVersion ||
            deploymentPackage?.sourceMaxApiVersion ||
            deploymentPackage?.sourceOrgApiVersion ||
            null,
        destinationApiVersion:
            deploymentApiVersionPolicy?.destinationMaxApiVersion || null,
        currentDeploymentApiVersion:
            deploymentApiVersionPolicy?.deploymentApiVersion,
        deploymentPackage,
        embeddedApiVersions:
            deploymentApiVersionPolicy?.embeddedApiVersions || []
    });

    const deploymentApiVersion = resolveDeploymentApiVersion({
        deploymentApiNegotiation,
        currentDeploymentApiVersion:
            deploymentApiVersionPolicy?.deploymentApiVersion
    });

    const compatibilityApiVersionPolicy = {
        ...deploymentApiVersionPolicy,
        deploymentApiVersion:
            deploymentApiNegotiation?.effectiveCompatibilityApiVersion ||
            deploymentApiVersion
    };

    metadataApiAdoptionTrace.beginAdoptionTrace();
    metadataApiAdoptionTrace.logNegotiationStage({
        currentDeploymentApiVersion:
            deploymentApiNegotiation.currentDeploymentApiVersion,
        sourceApiVersion: deploymentApiNegotiation.sourceApiVersion,
        destinationApiVersion: deploymentApiNegotiation.destinationApiVersion,
        negotiatedApiVersion: deploymentApiNegotiation.negotiatedApiVersion,
        effectiveCompatibilityApiVersion:
            deploymentApiNegotiation.effectiveCompatibilityApiVersion,
        negotiationStatus: deploymentApiNegotiation.negotiationStatus,
        adoptedDeploymentApiVersion: deploymentApiVersion
    });

    const permissionSetCompatibility =
        await analyzePermissionSetCompatibilitySafe({
            generatedDeploymentPackage,
            deploymentApiVersionPolicy: compatibilityApiVersionPolicy
        });

    metadataApiAdoptionTrace.logPlannerInputStage({
        plannerApiVersion: compatibilityApiVersionPolicy.deploymentApiVersion,
        effectiveCompatibilityApiVersion:
            deploymentApiNegotiation.effectiveCompatibilityApiVersion,
        negotiatedApiVersion: deploymentApiNegotiation.negotiatedApiVersion
    });

    const plan = await analyzeDeploymentCompatibilityPlan({
        generatedDeploymentPackage,
        permissionSetCompatibility,
        deploymentApiVersionPolicy: compatibilityApiVersionPolicy
    });

    metadataApiAdoptionTrace.logPackageStage({
        packageApiVersion: deploymentApiVersion
    });

    const generatedManifest = generateManifest(generatedDeploymentPackage, {
        deploymentApiVersion,
        deploymentApiVersionPolicy: {
            ...deploymentApiVersionPolicy,
            deploymentApiVersion
        }
    });

    metadataApiAdoptionTrace.logManifestStage({
        packageXml: generatedManifest.packageXml,
        manifestSummary: generatedManifest.summary
    });

    metadataApiAdoptionTrace.logWorkspaceStage({
        deploymentApiVersion: generatedManifest.summary.apiVersion
    });

    metadataApiAdoptionTrace.logCliStage({
        deploymentApiVersion: generatedManifest.summary.apiVersion
    });

    const cliCommand = buildProjectDeployCommand({
        workspacePath: '/tmp/deployment-workspace',
        alias: 'destination',
        deploymentApiVersion: generatedManifest.summary.apiVersion
    });

    metadataApiAdoptionTrace.logCliCommandStage({ cliCommand });
    metadataApiAdoptionTrace.logAdoptionReport();

    return {
        traceState: metadataApiAdoptionTrace.getAdoptionTraceState(),
        firstStageLost:
            metadataApiAdoptionTrace.resolveFirstStageLosingNegotiatedApi(),
        permissionSetBlocked: plan.compatibilityWarnings.some(
            (warning) =>
                warning.category === CATEGORIES.PERMISSION_SET_API_VERSION
        )
    };
}

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function main() {
    await runTest(
        'Production shape: no source org API is ever supplied',
        async () => {
            const result = await replayAdoptionChain({
                label: 'Production shape (source org version unavailable)',
                deploymentPackage: {
                    repoUrl: 'https://example.invalid/repo.git',
                    sourceBranch: 'main'
                },
                embeddedApiVersions: [
                    {
                        metadataType: 'PermissionSet',
                        metadataName: 'Subscription_Access',
                        apiVersion: '61.0'
                    }
                ],
                destinationMaxApiVersion: '64.0'
            });

            assert.strictEqual(result.traceState.sourceApi, '61.0');
            assert.strictEqual(result.traceState.destinationApi, '64.0');
            assert.strictEqual(result.traceState.negotiatedApi, '61.0');
            assert.strictEqual(result.traceState.plannerApi, '61.0');
            assert.strictEqual(result.traceState.packageXmlVersion, '61.0');
            assert.strictEqual(result.traceState.cliApi, '61.0');
            assert.strictEqual(result.firstStageLost, 'None');
            assert.strictEqual(result.permissionSetBlocked, true);
        }
    );

    await runTest(
        'Source org API supplied: 64.0 survives every stage',
        async () => {
            const result = await replayAdoptionChain({
                label: 'Source org API version available (66.0)',
                deploymentPackage: {
                    repoUrl: 'https://example.invalid/repo.git',
                    sourceBranch: 'main',
                    sourceApiVersion: '66.0'
                },
                embeddedApiVersions: [
                    {
                        metadataType: 'PermissionSet',
                        metadataName: 'Subscription_Access',
                        apiVersion: '61.0'
                    }
                ],
                destinationMaxApiVersion: '64.0'
            });

            assert.strictEqual(result.traceState.sourceApi, '66.0');
            assert.strictEqual(result.traceState.negotiatedApi, '64.0');
            assert.strictEqual(result.traceState.plannerApi, '64.0');
            assert.strictEqual(result.traceState.packageApi, '64.0');
            assert.strictEqual(result.traceState.packageXmlVersion, '64.0');
            assert.strictEqual(result.traceState.workspaceApi, '64.0');
            assert.strictEqual(result.traceState.cliApi, '64.0');
            assert.strictEqual(result.firstStageLost, 'None');
            assert.strictEqual(result.permissionSetBlocked, false);
        }
    );
}

main();
