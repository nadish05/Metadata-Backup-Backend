const assert = require('assert');

const {
    discoverSourceMetadataApiVersion
} = require('./sourceMetadataApiVersion.service');
const {
    NEGOTIATION_STATUS,
    negotiateDeploymentApiVersions
} = require('./deploymentApiNegotiation.service');

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

async function discoverVersion(deploymentPackage, sourceApiVersion = '66.0') {
    let refreshCalls = 0;
    let versionCalls = 0;

    const result = await discoverSourceMetadataApiVersion({
        deploymentPackage,
        sourceOrg: {
            refreshToken: 'source-refresh-token',
            instanceUrl: 'https://source.example.com'
        },
        refreshAccessTokenFn: async (refreshToken) => {
            refreshCalls += 1;
            assert.strictEqual(refreshToken, 'source-refresh-token');

            return {
                accessToken: 'source-access-token',
                instanceUrl: 'https://source.example.com'
            };
        },
        getLatestApiVersionFn: async (instanceUrl, accessToken) => {
            versionCalls += 1;
            assert.strictEqual(
                instanceUrl,
                'https://source.example.com'
            );
            assert.strictEqual(accessToken, 'source-access-token');
            return sourceApiVersion;
        }
    });

    return { result, refreshCalls, versionCalls };
}

async function main() {
    await runTest(
        'Source 66 and destination 64 negotiate Metadata API 64',
        async () => {
            const deploymentPackage = {};
            const discovery = await discoverVersion(deploymentPackage);
            const negotiation = negotiateDeploymentApiVersions({
                deploymentPackage,
                destinationApiVersion: '64.0',
                currentDeploymentApiVersion: '61.0',
                embeddedApiVersions: [{ apiVersion: '61.0' }]
            });

            assert.strictEqual(discovery.result, '66.0');
            assert.strictEqual(discovery.refreshCalls, 1);
            assert.strictEqual(discovery.versionCalls, 1);
            assert.strictEqual(deploymentPackage.sourceApiVersion, '66.0');
            assert.strictEqual(negotiation.sourceApiVersion, '66.0');
            assert.strictEqual(negotiation.destinationApiVersion, '64.0');
            assert.strictEqual(negotiation.negotiatedApiVersion, '64.0');
            assert.strictEqual(
                negotiation.effectiveCompatibilityApiVersion,
                '64.0'
            );
            assert.strictEqual(
                negotiation.negotiationStatus,
                NEGOTIATION_STATUS.READY_FOR_UPGRADE
            );
        }
    );

    await runTest(
        'Missing source credentials fall back to embedded metadata',
        async () => {
            const deploymentPackage = {};
            const discovered = await discoverSourceMetadataApiVersion({
                deploymentPackage,
                sourceOrg: null
            });
            const negotiation = negotiateDeploymentApiVersions({
                deploymentPackage,
                destinationApiVersion: '64.0',
                currentDeploymentApiVersion: '61.0',
                embeddedApiVersions: [{ apiVersion: '62.0' }]
            });

            assert.strictEqual(discovered, null);
            assert.strictEqual(deploymentPackage.sourceApiVersion, undefined);
            assert.strictEqual(negotiation.sourceApiVersion, '62.0');
            assert.strictEqual(negotiation.negotiatedApiVersion, '62.0');
        }
    );

    await runTest('Missing destination produces UNKNOWN negotiation', async () => {
        const deploymentPackage = {};
        await discoverVersion(deploymentPackage);

        const negotiation = negotiateDeploymentApiVersions({
            deploymentPackage,
            destinationApiVersion: null,
            currentDeploymentApiVersion: '61.0',
            embeddedApiVersions: [{ apiVersion: '61.0' }]
        });

        assert.strictEqual(negotiation.sourceApiVersion, '66.0');
        assert.strictEqual(negotiation.negotiatedApiVersion, null);
        assert.strictEqual(
            negotiation.negotiationStatus,
            NEGOTIATION_STATUS.UNKNOWN
        );
    });

    await runTest(
        'Embedded metadata never overrides the real source API',
        async () => {
            const deploymentPackage = {};
            await discoverVersion(deploymentPackage, '66.0');

            const negotiation = negotiateDeploymentApiVersions({
                deploymentPackage,
                destinationApiVersion: '64.0',
                currentDeploymentApiVersion: '61.0',
                embeddedApiVersions: [{ apiVersion: '70.0' }]
            });

            assert.strictEqual(negotiation.sourceApiVersion, '66.0');
            assert.strictEqual(negotiation.negotiatedApiVersion, '64.0');
        }
    );

    await runTest(
        'Explicit source API remains first in resolution order',
        async () => {
            const negotiation = negotiateDeploymentApiVersions({
                sourceApiVersion: '67.0',
                deploymentPackage: {
                    sourceApiVersion: '66.0',
                    sourceMaxApiVersion: '65.0'
                },
                destinationApiVersion: '68.0',
                currentDeploymentApiVersion: '61.0',
                embeddedApiVersions: [{ apiVersion: '70.0' }]
            });

            assert.strictEqual(negotiation.sourceApiVersion, '67.0');
            assert.strictEqual(negotiation.negotiatedApiVersion, '67.0');
        }
    );

    await runTest(
        'Existing source maximum precedes embedded metadata fallback',
        async () => {
            const negotiation = negotiateDeploymentApiVersions({
                deploymentPackage: {
                    sourceMaxApiVersion: '65.0'
                },
                destinationApiVersion: '66.0',
                currentDeploymentApiVersion: '61.0',
                embeddedApiVersions: [{ apiVersion: '70.0' }]
            });

            assert.strictEqual(negotiation.sourceApiVersion, '65.0');
            assert.strictEqual(negotiation.negotiatedApiVersion, '65.0');
        }
    );
}

main();
