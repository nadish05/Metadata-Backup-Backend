'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createDestinationMetadataRetriever,
    selectLogicalMemberFiles,
    FLOW_DESTINATION_VERSION_NOT_RETRIEVED
} = require('./destinationMetadataRetriever.service');
const {
    packMemberFiles
} = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    applyCanonicalFlowSnapshotPackPaths
} = require('../flowMetadata/flowMemberIdentity.service');
const {
    compareNewMemberForDeleteRollback,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');
const {
    buildRetrieveSuccessJson
} = require('../retrieval/flowVersionRetrieval.service');

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

function listSnapshotWorkspaces(root) {
    if (!fs.existsSync(root)) {
        return [];
    }

    return fs
        .readdirSync(root)
        .filter((name) => name.startsWith('dest-snapshot-'))
        .map((name) => path.join(root, name));
}

async function writeMemberFile(workRoot, relativePath, bytes) {
    const workspaces = listSnapshotWorkspaces(workRoot);
    assert.strictEqual(workspaces.length, 1);
    const target = path.join(workspaces[0], relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, bytes);
}

function packFlowV4(xml) {
    return packMemberFiles(
        applyCanonicalFlowSnapshotPackPaths(
            [
                {
                    relativePath:
                        'force-app/main/default/flows/Check_Amount-4.flow-meta.xml',
                    bytes: xml
                }
            ],
            'Check_Amount-4'
        )
    );
}

function buildFlowRetrieverHarness(workRoot, options = {}) {
    const versionXml =
        options.versionXml ||
        Buffer.from('<?xml version="1.0"?><Flow version="4"/>', 'utf8');
    const unversionedXml =
        options.unversionedXml ||
        Buffer.from('<?xml version="1.0"?><Flow version="1"/>', 'utf8');
    const versionedPath =
        'force-app/main/default/flows/Check_Amount-4.flow-meta.xml';
    const unversionedPath =
        'force-app/main/default/flows/Check_Amount.flow-meta.xml';

    return createDestinationMetadataRetriever({
        tmpdir: () => workRoot,
        ensureSfdxProject: async (workspacePath) => {
            await fs.promises.writeFile(
                path.join(workspacePath, 'sfdx-project.json'),
                '{}'
            );
            return { success: true, sourceApiVersion: '61.0' };
        },
        refreshAccessToken: async () => ({
            accessToken: 'access-token',
            instanceUrl: 'https://example.my.salesforce.com'
        }),
        loginSfOrg: async () => {},
        discoverFlowVersions:
            options.discoverFlowVersions ||
            (async () => ({
                apiVersion: '61.0',
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 4,
                        sourceFlowVersionId: '301NS00003Eov6NYAR',
                        definitionLatestVersionId: '301NS00003Eov6NYAR',
                        flowIsLatestVersion: true,
                        flowIsActiveVersion: false,
                        flowVersionStatus: 'Draft'
                    }
                ],
                definitions: [
                    {
                        developerName: 'Check_Amount',
                        latestVersionId: '301NS00003Eov6NYAR',
                        latestVersionNumber: 4
                    }
                ]
            })),
        retrieveSingleFlowVersion:
            options.retrieveSingleFlowVersion ||
            (options.strictVersionedRetrieveFails
                ? async () => {
                      throw new Error(
                          'Retrieve for Flow:Check_Amount-4 did not report a version-qualified filename for strict version identity (correlation=unversioned_filename).'
                      );
                  }
                : async ({ projectPath }) => {
                const absolute = path.join(projectPath, ...versionedPath.split('/'));
                await fs.promises.mkdir(path.dirname(absolute), {
                    recursive: true
                });
                await fs.promises.writeFile(absolute, versionXml);
                return {
                    workspaceArtifactPath: versionedPath,
                    retrievedArtifactPath: versionedPath,
                    retrievedArtifactCorrelation: 'versioned_filename',
                    artifactSha256: hashBytes(versionXml)
                };
            }),
        execAsync: async (command) => {
            if (String(command).includes('logout')) {
                return { stdout: '', stderr: '' };
            }

            await writeMemberFile(workRoot, unversionedPath, unversionedXml);

            return {
                stdout: JSON.stringify({ status: 0, result: { files: [] } }),
                stderr: ''
            };
        }
    });
}

(async () => {
    await runTest(
        'A. requireExact rejects unversioned-only Flow selection for version-qualified member',
        () => {
            const unversionedPath =
                'force-app/main/default/flows/Check_Amount.flow-meta.xml';

            assert.throws(
                () =>
                    selectLogicalMemberFiles(
                        [
                            {
                                relativePath: unversionedPath,
                                bytes: Buffer.from('v1-body')
                            }
                        ],
                        'Flow',
                        'Check_Amount-4',
                        { requireExactVersionQualifiedFlowArtifact: true }
                    ),
                /did not return the logical file/
            );
        }
    );

    await runTest(
        '1. v1 active v4 latest draft with only unversioned CLI file fails closed',
        async () => {
            const workRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), 'flow-drift-unversioned-latest-')
            );
            const unversionedPath =
                'force-app/main/default/flows/Check_Amount.flow-meta.xml';
            const unversionedXml = Buffer.from(
                '<?xml version="1.0"?><Flow version="1-active"/>',
                'utf8'
            );
            const retriever = createDestinationMetadataRetriever({
                tmpdir: () => workRoot,
                ensureSfdxProject: async (workspacePath) => {
                    await fs.promises.writeFile(
                        path.join(workspacePath, 'sfdx-project.json'),
                        '{}'
                    );
                    return { success: true, sourceApiVersion: '61.0' };
                },
                refreshAccessToken: async () => ({
                    accessToken: 'access-token',
                    instanceUrl: 'https://example.my.salesforce.com'
                }),
                loginSfOrg: async () => {},
                discoverFlowVersions: async () => ({
                    apiVersion: '61.0',
                    versions: [
                        {
                            flowDefinitionDeveloperName: 'Check_Amount',
                            sourceFlowVersionNumber: 4,
                            sourceFlowVersionId: '301NS00003Eov6NYAR',
                            flowIsLatestVersion: true,
                            flowIsActiveVersion: false
                        }
                    ],
                    definitions: [{ developerName: 'Check_Amount' }]
                }),
                execAsync: async (command) => {
                    if (String(command).includes('logout')) {
                        return { stdout: '', stderr: '' };
                    }

                    const cmd = String(command);

                    if (cmd.includes('Flow:Check_Amount-4')) {
                        await writeMemberFile(
                            workRoot,
                            unversionedPath,
                            unversionedXml
                        );
                        return {
                            stdout: buildRetrieveSuccessJson(unversionedPath),
                            stderr: ''
                        };
                    }

                    await writeMemberFile(
                        workRoot,
                        unversionedPath,
                        unversionedXml
                    );
                    return {
                        stdout: JSON.stringify({
                            status: 0,
                            result: { files: [] }
                        }),
                        stderr: ''
                    };
                }
            });

            await assert.rejects(
                () =>
                    retriever.retrieveDestinationMember({
                        refreshToken: 'refresh',
                        instanceUrl: 'https://example.my.salesforce.com',
                        metadataType: 'Flow',
                        metadataName: 'Check_Amount-4',
                        requireExactVersionQualifiedFlowArtifact: true
                    }),
                (error) => {
                    assert.strictEqual(
                        error.code,
                        FLOW_DESTINATION_VERSION_NOT_RETRIEVED
                    );
                    assert.match(
                        error.message,
                        /exact version identity|version-qualified filename|exact version artifact/i
                    );
                    return true;
                }
            );
            await fs.promises.rm(workRoot, { recursive: true, force: true });
        }
    );

    await runTest(
        'B. DELETE drift retrieve uses version-aware bytes when CLI returns only unversioned file',
        async () => {
            const workRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), 'flow-drift-exact-')
            );
            const versionXml = Buffer.from(
                '<?xml version="1.0"?><Flow deployed-v4="true"/>',
                'utf8'
            );
            const retriever = buildFlowRetrieverHarness(workRoot, {
                versionXml,
                unversionedXml: versionXml,
                strictVersionedRetrieveFails: true
            });

            const result = await retriever.retrieveDestinationMember({
                refreshToken: 'refresh',
                instanceUrl: 'https://example.my.salesforce.com',
                metadataType: 'Flow',
                metadataName: 'Check_Amount-4',
                requireExactVersionQualifiedFlowArtifact: true
            });

            const expectedAfterHash = hashBytes(packFlowV4(versionXml));
            assert.strictEqual(hashBytes(result.artifactBytes), expectedAfterHash);
            assert.strictEqual(result.flowExactVersionArtifactVerified, true);
            assert.strictEqual(
                result.exactVersionRecovery?.retrievedArtifactCorrelation,
                'tooling_bound_unversioned_latest'
            );
            await fs.promises.rm(workRoot, { recursive: true, force: true });
        }
    );

    await runTest(
        'C. exact version artifact with different bytes remains DRIFTED',
        async () => {
            const workRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), 'flow-drift-mismatch-')
            );
            const deployedXml = Buffer.from(
                '<?xml version="1.0"?><Flow deployed-v4="true"/>',
                'utf8'
            );
            const otherXml = Buffer.from(
                '<?xml version="1.0"?><Flow other="true"/>',
                'utf8'
            );
            const retriever = buildFlowRetrieverHarness(workRoot, {
                versionXml: otherXml
            });

            const retrieved = await retriever.retrieveDestinationMember({
                refreshToken: 'refresh',
                instanceUrl: 'https://example.my.salesforce.com',
                metadataType: 'Flow',
                metadataName: 'Check_Amount-4',
                requireExactVersionQualifiedFlowArtifact: true
            });

            const comparison = compareNewMemberForDeleteRollback({
                expectedAfterHash: hashBytes(packFlowV4(deployedXml)),
                currentDestinationHash: hashBytes(retrieved.artifactBytes)
            });

            assert.strictEqual(
                comparison.classification,
                DRIFT_CLASSIFICATION.DRIFTED
            );
            await fs.promises.rm(workRoot, { recursive: true, force: true });
        }
    );

    await runTest(
        'D. Tooling failure during exact version recovery fails closed',
        async () => {
            const workRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), 'flow-drift-tooling-')
            );
            const retriever = buildFlowRetrieverHarness(workRoot, {
                discoverFlowVersions: async () => {
                    throw new Error('tooling unavailable');
                }
            });

            await assert.rejects(
                () =>
                    retriever.retrieveDestinationMember({
                        refreshToken: 'refresh',
                        instanceUrl: 'https://example.my.salesforce.com',
                        metadataType: 'Flow',
                        metadataName: 'Check_Amount-4',
                        requireExactVersionQualifiedFlowArtifact: true
                    }),
                (error) => {
                    assert.strictEqual(
                        error.code,
                        FLOW_DESTINATION_VERSION_NOT_RETRIEVED
                    );
                    assert.match(
                        error.message,
                        /rollback drift verification/
                    );
                    return true;
                }
            );
            await fs.promises.rm(workRoot, { recursive: true, force: true });
        }
    );

    await runTest(
        'E. unversioned Flow DELETE retrieve still accepts unversioned filename',
        async () => {
            const workRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), 'flow-drift-unversioned-')
            );
            const flowPath =
                'force-app/main/default/flows/My_Flow.flow-meta.xml';
            const flowBytes = Buffer.from('<?xml version="1.0"?><Flow/>', 'utf8');
            const retriever = createDestinationMetadataRetriever({
                tmpdir: () => workRoot,
                ensureSfdxProject: async (workspacePath) => {
                    await fs.promises.writeFile(
                        path.join(workspacePath, 'sfdx-project.json'),
                        '{}'
                    );
                    return { success: true, sourceApiVersion: '61.0' };
                },
                refreshAccessToken: async () => ({
                    accessToken: 'token',
                    instanceUrl: 'https://example.my.salesforce.com'
                }),
                loginSfOrg: async () => {},
                execAsync: async (command) => {
                    if (String(command).includes('logout')) {
                        return { stdout: '', stderr: '' };
                    }

                    await writeMemberFile(workRoot, flowPath, flowBytes);
                    return {
                        stdout: JSON.stringify({
                            status: 0,
                            result: { files: [] }
                        }),
                        stderr: ''
                    };
                }
            });

            const result = await retriever.retrieveDestinationMember({
                refreshToken: 'refresh',
                instanceUrl: 'https://example.my.salesforce.com',
                metadataType: 'Flow',
                metadataName: 'My_Flow'
            });

            assert.strictEqual(
                hashBytes(result.artifactBytes),
                hashBytes(packMemberFiles([{ relativePath: flowPath, bytes: flowBytes }]))
            );
            await fs.promises.rm(workRoot, { recursive: true, force: true });
        }
    );

    await runTest('F. ApexClass DELETE retrieve unchanged without exact-flow flag', async () => {
        const workRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'flow-drift-apex-')
        );
        const clsPath = 'force-app/main/default/classes/Demo.cls';
        const clsBytes = Buffer.from('public class Demo {}\n', 'utf8');
        const retriever = createDestinationMetadataRetriever({
            tmpdir: () => workRoot,
            ensureSfdxProject: async (workspacePath) => {
                await fs.promises.writeFile(
                    path.join(workspacePath, 'sfdx-project.json'),
                    '{}'
                );
                return { success: true, sourceApiVersion: '61.0' };
            },
            refreshAccessToken: async () => ({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            }),
            loginSfOrg: async () => {},
            execAsync: async (command) => {
                if (String(command).includes('logout')) {
                    return { stdout: '', stderr: '' };
                }

                await writeMemberFile(workRoot, clsPath, clsBytes);
                return {
                    stdout: JSON.stringify({
                        status: 0,
                        result: { files: [] }
                    }),
                    stderr: ''
                };
            }
        });

        const result = await retriever.retrieveDestinationMember({
            refreshToken: 'refresh',
            instanceUrl: 'https://example.my.salesforce.com',
            metadataType: 'ApexClass',
            metadataName: 'Demo',
            requireExactVersionQualifiedFlowArtifact: true
        });

        assert.strictEqual(
            hashBytes(result.artifactBytes),
            hashBytes(packMemberFiles([{ relativePath: clsPath, bytes: clsBytes }]))
        );
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

})();
