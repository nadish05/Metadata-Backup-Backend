const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    RETRIEVAL_METADATA_PATH,
    readRepositorySnapshotMetadata
} = require('./repositorySnapshotMetadata.service');
const {
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

async function loadDeploymentPackage(readFile) {
    const deploymentPackage = {};
    const snapshotMetadata = await readRepositorySnapshotMetadata({
        readFile
    });

    deploymentPackage.sourceApiVersion =
        snapshotMetadata?.sourceMetadataApiVersion || null;

    return { deploymentPackage, snapshotMetadata };
}

async function main() {
    await runTest('Snapshot exists', async () => {
        let requestedPath = null;
        const snapshot = await readRepositorySnapshotMetadata({
            readFile: async (relativePath) => {
                requestedPath = relativePath;

                return JSON.stringify({
                    snapshotVersion: 1,
                    sourceOrgId: '00D000000000001',
                    sourceMetadataApiVersion: '67.0',
                    retrievedAt: '2026-08-06T08:35:22Z',
                    ignoredSecret: 'not-returned'
                });
            }
        });

        assert.strictEqual(requestedPath, RETRIEVAL_METADATA_PATH);
        assert.deepStrictEqual(snapshot, {
            snapshotVersion: 1,
            sourceOrgId: '00D000000000001',
            sourceMetadataApiVersion: '67.0',
            retrievedAt: '2026-08-06T08:35:22Z'
        });
    });

    await runTest('Snapshot missing', async () => {
        const snapshot = await readRepositorySnapshotMetadata({
            readFile: async () => {
                const error = new Error('File not found');
                error.code = 'ENOENT';
                throw error;
            }
        });

        assert.strictEqual(snapshot, null);
    });

    await runTest('Malformed JSON', async () => {
        const snapshot = await readRepositorySnapshotMetadata({
            readFile: async () => '{invalid-json'
        });

        assert.strictEqual(snapshot, null);
    });

    await runTest('Missing API version', async () => {
        const snapshot = await readRepositorySnapshotMetadata({
            readFile: async () =>
                JSON.stringify({
                    snapshotVersion: 1,
                    sourceOrgId: '00D000000000001',
                    retrievedAt: '2026-08-06T08:35:22Z'
                })
        });

        assert.ok(snapshot);
        assert.strictEqual(snapshot.sourceMetadataApiVersion, null);
    });

    await runTest(
        'DeploymentPackage receives repository sourceApiVersion',
        async () => {
            const { deploymentPackage } = await loadDeploymentPackage(
                async () =>
                    JSON.stringify({
                        snapshotVersion: 1,
                        sourceOrgId: '00D000000000001',
                        sourceMetadataApiVersion: '67.0',
                        retrievedAt: '2026-08-06T08:35:22Z'
                    })
            );
            const validationSource = fs.readFileSync(
                path.join(__dirname, 'deploymentValidation.service.js'),
                'utf8'
            );

            assert.strictEqual(
                deploymentPackage.sourceApiVersion,
                '67.0'
            );
            assert.ok(
                validationSource.includes(
                    'repositorySnapshotMetadataService.readRepositorySnapshotMetadata'
                )
            );
            assert.ok(
                validationSource.includes(
                    'repositorySnapshotMetadata?.sourceMetadataApiVersion || null'
                )
            );
            assert.strictEqual(
                validationSource.includes(
                    'sourceMetadataApiVersionService.discoverSourceMetadataApiVersion'
                ),
                false
            );
        }
    );

    await runTest(
        'Negotiation receives repository version',
        async () => {
            const { deploymentPackage } = await loadDeploymentPackage(
                async () =>
                    JSON.stringify({
                        snapshotVersion: 1,
                        sourceMetadataApiVersion: '67.0'
                    })
            );
            const negotiation = negotiateDeploymentApiVersions({
                deploymentPackage,
                destinationApiVersion: '67.0',
                currentDeploymentApiVersion: '61.0',
                embeddedApiVersions: [{ apiVersion: '61.0' }]
            });

            assert.strictEqual(negotiation.sourceApiVersion, '67.0');
            assert.strictEqual(negotiation.destinationApiVersion, '67.0');
            assert.strictEqual(negotiation.negotiatedApiVersion, '67.0');
        }
    );

    await runTest('Fallback when snapshot is absent', async () => {
        const { deploymentPackage, snapshotMetadata } =
            await loadDeploymentPackage(async () => {
                throw new Error('missing');
            });
        const negotiation = negotiateDeploymentApiVersions({
            deploymentPackage,
            destinationApiVersion: '67.0',
            currentDeploymentApiVersion: '61.0',
            embeddedApiVersions: [{ apiVersion: '62.0' }]
        });

        assert.strictEqual(snapshotMetadata, null);
        assert.strictEqual(deploymentPackage.sourceApiVersion, null);
        assert.strictEqual(negotiation.sourceApiVersion, '62.0');
        assert.strictEqual(negotiation.negotiatedApiVersion, '62.0');
    });
}

main();
