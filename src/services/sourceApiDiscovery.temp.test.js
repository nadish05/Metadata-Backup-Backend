/**
 * TEMPORARY DEBUG ONLY — Phase 13.5.1 Source API Discovery Investigation.
 *
 * Replays the discovery pipeline offline under the conditions the production
 * deployment actually runs in, so the trace can name the first failing step.
 * Remove together with sourceApiDiscoveryTrace.temp.js.
 */

const assert = require('assert');

const {
    discoverSourceMetadataApiVersion
} = require('./sourceMetadataApiVersion.service');
const {
    negotiateDeploymentApiVersionsSafe
} = require('./deploymentApiNegotiation.service');
const sourceApiDiscoveryTrace = require('./sourceApiDiscoveryTrace.temp');

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

/**
 * Mirrors validateDeployment: step 1 identifier, discovery, then negotiation.
 */
async function replayDiscovery({
    label,
    deploymentPackage = {},
    sourceOrg = null,
    refreshAccessTokenFn = null,
    getLatestApiVersionFn = null,
    destinationMaxApiVersion = null,
    embeddedApiVersions = []
}) {
    console.log('##################################################');
    console.log('SCENARIO:', label);
    console.log('##################################################');

    sourceApiDiscoveryTrace.beginSourceApiDiscoveryTrace();
    sourceApiDiscoveryTrace.traceSourceOrgIdentifier({
        sourceOrgId:
            deploymentPackage?.sourceOrgId ||
            deploymentPackage?.sourceOrg?.orgId ||
            null,
        identifierField: 'deploymentPackage.sourceOrgId'
    });

    await discoverSourceMetadataApiVersion({
        deploymentPackage,
        sourceOrg,
        refreshAccessTokenFn,
        getLatestApiVersionFn
    });

    const negotiation = negotiateDeploymentApiVersionsSafe({
        sourceApiVersion: deploymentPackage?.sourceApiVersion || null,
        destinationApiVersion: destinationMaxApiVersion,
        currentDeploymentApiVersion: '61.0',
        deploymentPackage,
        embeddedApiVersions
    });

    sourceApiDiscoveryTrace.traceNegotiationInput({
        sourceApiVersion: negotiation?.sourceApiVersion || null,
        destinationApiVersion: negotiation?.destinationApiVersion || null
    });
    sourceApiDiscoveryTrace.logSourceApiDiscoveryTrace();

    return {
        negotiation,
        firstFailure: sourceApiDiscoveryTrace.resolveFirstFailure(),
        traceState: sourceApiDiscoveryTrace.getSourceApiDiscoveryTraceState()
    };
}

async function main() {
    await runTest(
        'Production shape: no connected source org in the OAuth store',
        async () => {
            const result = await replayDiscovery({
                label: 'Production shape (oauthStore empty)',
                deploymentPackage: {
                    repoUrl: 'https://example.invalid/repo.git',
                    sourceBranch: 'main'
                },
                sourceOrg: null,
                refreshAccessTokenFn: async () => {
                    throw new Error('refresh must not run without an org');
                },
                getLatestApiVersionFn: async () => {
                    throw new Error('discovery must not run without an org');
                },
                destinationMaxApiVersion: '67.0'
            });

            assert.strictEqual(result.traceState.step1.present, false);
            assert.strictEqual(result.traceState.step2.connectedOrgFound, false);
            assert.strictEqual(result.firstFailure.step, 'Step 1');
            assert.strictEqual(result.negotiation.sourceApiVersion, null);
            assert.strictEqual(result.negotiation.negotiatedApiVersion, null);
            assert.strictEqual(result.negotiation.negotiationStatus, 'UNKNOWN');
        }
    );

    await runTest(
        'Sandbox source org: refresh against login.salesforce.com fails',
        async () => {
            const invalidGrant = new Error('Request failed with status code 400');
            invalidGrant.response = {
                status: 400,
                data: {
                    error: 'invalid_grant',
                    error_description: 'expired access/refresh token'
                }
            };

            const result = await replayDiscovery({
                label: 'Sandbox source org (refresh host mismatch)',
                deploymentPackage: {
                    repoUrl: 'https://example.invalid/repo.git',
                    sourceBranch: 'main'
                },
                sourceOrg: {
                    orgId: '00DSB0000001234',
                    instanceUrl: 'https://my-sandbox.sandbox.my.salesforce.com',
                    refreshToken: 'sandbox-refresh-token'
                },
                refreshAccessTokenFn: async () => {
                    throw invalidGrant;
                },
                getLatestApiVersionFn: async () => '66.0',
                destinationMaxApiVersion: '67.0'
            });

            assert.strictEqual(result.traceState.step2.connectedOrgFound, true);
            assert.strictEqual(
                result.traceState.step3.accessTokenGenerated,
                false
            );
            assert.strictEqual(result.firstFailure.step, 'Step 3');
            assert.strictEqual(result.negotiation.negotiationStatus, 'UNKNOWN');
        }
    );

    await runTest(
        'Healthy source org: discovery completes end to end',
        async () => {
            const result = await replayDiscovery({
                label: 'Healthy connected source org',
                deploymentPackage: {
                    repoUrl: 'https://example.invalid/repo.git',
                    sourceBranch: 'main'
                },
                sourceOrg: {
                    orgId: '00D0000000012345',
                    instanceUrl: 'https://source.my.salesforce.com',
                    refreshToken: 'source-refresh-token'
                },
                refreshAccessTokenFn: async () => ({
                    accessToken: 'source-access-token',
                    instanceUrl: 'https://source.my.salesforce.com'
                }),
                getLatestApiVersionFn: async () => '66.0',
                destinationMaxApiVersion: '67.0'
            });

            assert.strictEqual(result.traceState.step5.resolvedApiVersion, '66.0');
            assert.strictEqual(result.traceState.step6.stored, true);
            assert.strictEqual(result.firstFailure.step, 'None');
            assert.strictEqual(result.negotiation.sourceApiVersion, '66.0');
            assert.strictEqual(result.negotiation.negotiatedApiVersion, '66.0');
        }
    );
}

main();
