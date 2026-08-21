/**
 * P0-4 — CustomMetadata Type.Record artifact / workspace path resolution.
 */

const assert = require('assert');
const path = require('path');

const genericFileArtifactResolver = require('./resolvers/genericFile.resolver');
const { enrichNode } = require('./artifactResolution.service');
const {
    resolveCustomMetadataPath
} = require('../deploymentWorkspace.service');
const { METADATA_TYPE_RULES } = require('../../config/metadataTypes');

const SUFFIX = METADATA_TYPE_RULES.CustomMetadata.extension;

const DEFAULT_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Default.md-meta.xml';
const PRODUCTION_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Production.md-meta.xml';
const TEST_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Test.md-meta.xml';

const REPO_FILES = [DEFAULT_PATH, PRODUCTION_PATH, TEST_PATH];

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
        'TEST 1: Weather_Config.Default resolves to Type.Record.md-meta.xml',
        () => {
            const resolved = genericFileArtifactResolver.resolve({
                name: 'Weather_Config.Default',
                metadataType: 'CustomMetadata',
                repoFiles: REPO_FILES
            });

            assert.strictEqual(resolved, DEFAULT_PATH);

            const enriched = enrichNode(
                {
                    metadataType: 'CustomMetadata',
                    name: 'Weather_Config.Default',
                    metadataName: 'Weather_Config.Default'
                },
                REPO_FILES
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.sourceExists, true);
            assert.strictEqual(enriched.filePath, DEFAULT_PATH);
            assert.strictEqual(enriched.name, 'Weather_Config.Default');
        }
    );

    await runTest(
        'TEST 2: multiple Type.Record files resolve without collision',
        () => {
            assert.strictEqual(
                genericFileArtifactResolver.resolve({
                    name: 'Weather_Config.Default',
                    metadataType: 'CustomMetadata',
                    repoFiles: REPO_FILES
                }),
                DEFAULT_PATH
            );
            assert.strictEqual(
                genericFileArtifactResolver.resolve({
                    name: 'Weather_Config.Production',
                    metadataType: 'CustomMetadata',
                    repoFiles: REPO_FILES
                }),
                PRODUCTION_PATH
            );
            assert.strictEqual(
                genericFileArtifactResolver.resolve({
                    name: 'Weather_Config.Test',
                    metadataType: 'CustomMetadata',
                    repoFiles: REPO_FILES
                }),
                TEST_PATH
            );

            assert.strictEqual(
                resolveCustomMetadataPath('Weather_Config.Default', REPO_FILES),
                DEFAULT_PATH
            );
            assert.strictEqual(
                resolveCustomMetadataPath(
                    'Weather_Config.Production',
                    REPO_FILES
                ),
                PRODUCTION_PATH
            );
            assert.strictEqual(
                resolveCustomMetadataPath('Weather_Config.Test', REPO_FILES),
                TEST_PATH
            );
        }
    );

    await runTest(
        'TEST 3: missing CustomMetadata artifact remains unresolved',
        () => {
            assert.strictEqual(
                genericFileArtifactResolver.resolve({
                    name: 'Weather_Config.Missing',
                    metadataType: 'CustomMetadata',
                    repoFiles: REPO_FILES
                }),
                null
            );

            const enriched = enrichNode(
                {
                    metadataType: 'CustomMetadata',
                    name: 'Weather_Config.Missing'
                },
                REPO_FILES
            );

            assert.strictEqual(enriched.artifactResolved, false);
            assert.strictEqual(enriched.sourceExists, false);
            assert.strictEqual(enriched.filePath, null);

            assert.strictEqual(
                resolveCustomMetadataPath('Weather_Config.Missing', REPO_FILES),
                null
            );
        }
    );

    await runTest(
        'TEST 4: exact valid filePath preserves successful enrichment',
        () => {
            const enriched = enrichNode(
                {
                    metadataType: 'CustomMetadata',
                    name: 'Weather_Config.Default',
                    filePath: DEFAULT_PATH,
                    artifactResolved: true
                },
                REPO_FILES
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.sourceExists, true);
            assert.strictEqual(enriched.filePath, DEFAULT_PATH);
        }
    );

    await runTest(
        'TEST 5: logical metadataName stays Weather_Config.Default (not Default)',
        () => {
            const enriched = enrichNode(
                {
                    metadataType: 'CustomMetadata',
                    name: 'Weather_Config.Default'
                },
                REPO_FILES
            );

            assert.strictEqual(enriched.name, 'Weather_Config.Default');
            assert.strictEqual(enriched.metadataName, undefined);
            assert.notStrictEqual(
                path.basename(enriched.filePath, SUFFIX),
                'Default'
            );
            assert.strictEqual(
                path.basename(enriched.filePath, SUFFIX),
                'Weather_Config.Default'
            );

            // Must not recreate the old .pop() behavior.
            assert.notStrictEqual(
                genericFileArtifactResolver.resolve({
                    name: 'Default',
                    metadataType: 'CustomMetadata',
                    repoFiles: REPO_FILES
                }),
                DEFAULT_PATH
            );
        }
    );

    await runTest(
        'TEST 6: basename strips .md-meta.xml and retains Type.Record',
        () => {
            assert.strictEqual(SUFFIX, '.md-meta.xml');
            assert.strictEqual(
                path.basename(DEFAULT_PATH, SUFFIX),
                'Weather_Config.Default'
            );
            assert.ok(!path.basename(DEFAULT_PATH, SUFFIX).endsWith(SUFFIX));
        }
    );

    await runTest(
        'TEST 7 regression: non-CustomMetadata FILE resolution unchanged',
        () => {
            const namedCredentialPath =
                'force-app/main/default/namedCredentials/Weather_Endpoint.namedCredential-meta.xml';
            const flowPath =
                'force-app/main/default/flows/Create_Booking.flow-meta.xml';

            assert.strictEqual(
                genericFileArtifactResolver.resolve({
                    name: 'Weather_Endpoint',
                    metadataType: 'NamedCredential',
                    repoFiles: [namedCredentialPath, ...REPO_FILES]
                }),
                namedCredentialPath
            );

            assert.strictEqual(
                genericFileArtifactResolver.resolve({
                    name: 'Create_Booking',
                    metadataType: 'Flow',
                    repoFiles: [flowPath, ...REPO_FILES]
                }),
                flowPath
            );
        }
    );

    if (process.exitCode) {
        console.error('customMetadataArtifactResolution.test.js FAILED');
    } else {
        console.log('customMetadataArtifactResolution.test.js PASSED');
    }
}

main();
