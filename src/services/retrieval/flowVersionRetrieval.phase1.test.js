'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const {
    hashBytes,
    persistVersionArtifact,
    retrieveSingleFlowVersion,
    runFlowVersionRetrievalExtension,
    resolveRetrievedFlowPath,
    resolveReportedPathWithinProject,
    readProjectFile,
    buildRetrieveSuccessJson
} = require('./flowVersionRetrieval.service');

const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

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

function versionDescriptor(developerName, versionNumber, id, options = {}) {
    return {
        flowDefinitionDeveloperName: developerName,
        sourceFlowVersionNumber: versionNumber,
        sourceFlowVersionId: id,
        flowIsLatestVersion: options.flowIsLatestVersion === true,
        requestedMetadataMemberName: `${developerName}-${versionNumber}`,
        requestedMetadataMember: `Flow:${developerName}-${versionNumber}`
    };
}

function flowsDir(root) {
    return path.join(root, 'force-app', 'main', 'default', 'flows');
}

(async () => {
    await runTest('resolveRetrievedFlowPath accepts versioned CLI path', () => {
        const resolved = resolveRetrievedFlowPath({
            retrievedFiles: [
                {
                    filePath:
                        'force-app/main/default/flows/Active_Customer-1.flow-meta.xml'
                }
            ],
            developerName: 'Active_Customer',
            versionNumber: 1,
            flowIsLatestVersion: false
        });

        assert.strictEqual(resolved.correlation, 'versioned_filename');
        assert.ok(
            resolved.relativePath.endsWith('Active_Customer-1.flow-meta.xml')
        );
    });

    await runTest(
        'resolveRetrievedFlowPath accepts unversioned path only for latest',
        () => {
            const resolved = resolveRetrievedFlowPath({
                retrievedFiles: [
                    {
                        filePath:
                            'force-app/main/default/flows/Active_Customer.flow-meta.xml'
                    }
                ],
                developerName: 'Active_Customer',
                versionNumber: 3,
                flowIsLatestVersion: true
            });

            assert.strictEqual(resolved.correlation, 'unversioned_filename');
        }
    );

    await runTest(
        'resolveRetrievedFlowPath rejects unversioned path for non-latest',
        () => {
            const resolved = resolveRetrievedFlowPath({
                retrievedFiles: [
                    {
                        filePath:
                            'force-app/main/default/flows/Active_Customer.flow-meta.xml'
                    }
                ],
                developerName: 'Active_Customer',
                versionNumber: 1,
                flowIsLatestVersion: false
            });

            assert.strictEqual(resolved, null);
        }
    );

    await runTest(
        'resolveRetrievedFlowPath rejects unrelated CLI file for requested version',
        () => {
            const resolved = resolveRetrievedFlowPath({
                retrievedFiles: [
                    {
                        filePath:
                            'force-app/main/default/flows/Other_Flow.flow-meta.xml'
                    }
                ],
                developerName: 'Active_Customer',
                versionNumber: 1,
                flowIsLatestVersion: false
            });

            assert.strictEqual(resolved, null);
        }
    );

    await runTest(
        'resolveRetrievedFlowPath rejects mismatched versioned filename',
        () => {
            const resolved = resolveRetrievedFlowPath({
                retrievedFiles: [
                    {
                        filePath:
                            'force-app/main/default/flows/Active_Customer-2.flow-meta.xml'
                    }
                ],
                developerName: 'Active_Customer',
                versionNumber: 1,
                flowIsLatestVersion: false
            });

            assert.strictEqual(resolved, null);
        }
    );

    await runTest('readProjectFile resolves relative path under project', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-read-relative-')
        );
        const flows = flowsDir(root);
        const content = '<Flow>relative</Flow>';

        await mkdir(flows, { recursive: true });
        await writeFile(
            path.join(flows, 'Active_Customer-1.flow-meta.xml'),
            content,
            'utf8'
        );

        const bytes = await readProjectFile(
            root,
            'force-app/main/default/flows/Active_Customer-1.flow-meta.xml'
        );

        assert.strictEqual(bytes.toString('utf8'), content);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('readProjectFile resolves absolute path under project', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-read-absolute-')
        );
        const flows = flowsDir(root);
        const content = '<Flow>absolute</Flow>';
        const absoluteReported = path.join(
            flows,
            'Active_Customer-1.flow-meta.xml'
        );

        await mkdir(flows, { recursive: true });
        await writeFile(absoluteReported, content, 'utf8');

        const bytes = await readProjectFile(root, absoluteReported);

        assert.strictEqual(bytes.toString('utf8'), content);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest(
        'readProjectFile returns null for absolute path outside project',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-read-outside-')
            );
            const outside = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-outside-')
            );

            await writeFile(
                path.join(outside, 'Active_Customer-1.flow-meta.xml'),
                '<Flow>outside</Flow>',
                'utf8'
            );

            const resolved = resolveReportedPathWithinProject(
                root,
                path.join(outside, 'Active_Customer-1.flow-meta.xml')
            );

            assert.strictEqual(resolved, null);
            assert.strictEqual(
                await readProjectFile(
                    root,
                    path.join(outside, 'Active_Customer-1.flow-meta.xml')
                ),
                null
            );

            await fs.promises.rm(root, { recursive: true, force: true });
            await fs.promises.rm(outside, { recursive: true, force: true });
        }
    );

    await runTest(
        'retrieveSingleFlowVersion reads absolute versioned CLI filePath',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-retrieve-abs-versioned-')
            );
            const flows = flowsDir(root);
            const absoluteReported = path.join(
                flows,
                'Active_Customer-1.flow-meta.xml'
            );

            await mkdir(flows, { recursive: true });
            await writeFile(absoluteReported, '<Flow>v1</Flow>', 'utf8');

            const result = await retrieveSingleFlowVersion({
                projectPath: root,
                alias: 'temporg',
                versionDescriptor: versionDescriptor(
                    'Active_Customer',
                    1,
                    'id-1'
                ),
                execAsync: async () => ({
                    stdout: buildRetrieveSuccessJson(absoluteReported)
                })
            });

            assert.strictEqual(
                result.workspaceArtifactPath,
                'force-app/main/default/flows/Active_Customer-1.flow-meta.xml'
            );
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest(
        'retrieveSingleFlowVersion reads absolute unversioned path for latest',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-retrieve-abs-unversioned-')
            );
            const flows = flowsDir(root);
            const absoluteReported = path.join(
                flows,
                'Active_Customer.flow-meta.xml'
            );

            await mkdir(flows, { recursive: true });
            await writeFile(absoluteReported, '<Flow>latest</Flow>', 'utf8');

            const result = await retrieveSingleFlowVersion({
                projectPath: root,
                alias: 'temporg',
                versionDescriptor: versionDescriptor(
                    'Active_Customer',
                    2,
                    'id-2',
                    { flowIsLatestVersion: true }
                ),
                execAsync: async () => ({
                    stdout: buildRetrieveSuccessJson(absoluteReported)
                })
            });

            assert.strictEqual(
                result.workspaceArtifactPath,
                'force-app/main/default/flows/Active_Customer-2.flow-meta.xml'
            );
            assert.strictEqual(
                result.retrievedArtifactCorrelation,
                'unversioned_filename'
            );
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest('persistVersionArtifact writes canonical versioned path', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-version-persist-')
        );
        const bytes = Buffer.from('<Flow>one</Flow>', 'utf8');

        const persisted = await persistVersionArtifact({
            projectPath: root,
            developerName: 'Active_Customer',
            versionNumber: 1,
            sourceBytes: bytes
        });

        assert.strictEqual(
            persisted.workspaceArtifactPath,
            'force-app/main/default/flows/Active_Customer-1.flow-meta.xml'
        );

        const onDisk = await fs.promises.readFile(
            path.join(root, ...persisted.workspaceArtifactPath.split('/'))
        );

        assert.strictEqual(hashBytes(onDisk), hashBytes(bytes));
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('retrieveSingleFlowVersion maps one version to canonical file', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-version-retrieve-')
        );
        const flows = flowsDir(root);
        const relative =
            'force-app/main/default/flows/Active_Customer-1.flow-meta.xml';

        await mkdir(flows, { recursive: true });
        await writeFile(
            path.join(flows, 'Active_Customer-1.flow-meta.xml'),
            '<Flow>version-1</Flow>',
            'utf8'
        );

        const result = await retrieveSingleFlowVersion({
            projectPath: root,
            alias: 'temporg',
            versionDescriptor: versionDescriptor('Active_Customer', 1, 'id-1'),
            execAsync: async () => ({
                stdout: buildRetrieveSuccessJson(relative)
            })
        });

        assert.strictEqual(result.workspaceArtifactPath, relative);
        assert.strictEqual(result.retrievedArtifactCorrelation, 'versioned_filename');
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest(
        'retrieveSingleFlowVersion maps latest unversioned CLI path to versioned artifact',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-version-retrieve-')
            );
            const flows = flowsDir(root);
            const cliRelative =
                'force-app/main/default/flows/Active_Customer.flow-meta.xml';

            await mkdir(flows, { recursive: true });
            await writeFile(
                path.join(flows, 'Active_Customer.flow-meta.xml'),
                '<Flow>version-3</Flow>',
                'utf8'
            );

            const result = await retrieveSingleFlowVersion({
                projectPath: root,
                alias: 'temporg',
                versionDescriptor: versionDescriptor(
                    'Active_Customer',
                    3,
                    'id-3',
                    { flowIsLatestVersion: true }
                ),
                execAsync: async () => ({
                    stdout: buildRetrieveSuccessJson(cliRelative)
                })
            });

            assert.strictEqual(
                result.workspaceArtifactPath,
                'force-app/main/default/flows/Active_Customer-3.flow-meta.xml'
            );
            assert.strictEqual(
                result.retrievedArtifactCorrelation,
                'unversioned_filename'
            );
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest(
        'retrieveSingleFlowVersion strict mode rejects unversioned latest correlation',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-version-strict-')
            );
            const flows = flowsDir(root);
            const cliRelative =
                'force-app/main/default/flows/Active_Customer.flow-meta.xml';

            await mkdir(flows, { recursive: true });
            await writeFile(
                path.join(flows, 'Active_Customer.flow-meta.xml'),
                '<Flow>version-3</Flow>',
                'utf8'
            );

            await assert.rejects(
                () =>
                    retrieveSingleFlowVersion({
                        projectPath: root,
                        alias: 'temporg',
                        versionDescriptor: versionDescriptor(
                            'Active_Customer',
                            3,
                            'id-3',
                            { flowIsLatestVersion: true }
                        ),
                        execAsync: async () => ({
                            stdout: buildRetrieveSuccessJson(cliRelative)
                        }),
                        requireVersionedFilenameCorrelation: true
                    }),
                /version-qualified filename/
            );
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest(
        'retrieveSingleFlowVersion fails when CLI does not report an acceptable file',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-version-fail-')
            );

            await mkdir(flowsDir(root), { recursive: true });

            let failed = false;

            try {
                await retrieveSingleFlowVersion({
                    projectPath: root,
                    alias: 'temporg',
                    versionDescriptor: versionDescriptor(
                        'Active_Customer',
                        1,
                        'id-1'
                    ),
                    execAsync: async () => ({
                        stdout: buildRetrieveSuccessJson(
                            'force-app/main/default/flows/Wrong.flow-meta.xml'
                        )
                    })
                });
            } catch (error) {
                failed = true;
                assert.ok(error.message.includes('did not report'));
            }

            assert.strictEqual(failed, true);
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest(
        'retrieveSingleFlowVersion fails when CLI reports file but disk is missing',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-version-missing-')
            );

            let failed = false;

            try {
                await retrieveSingleFlowVersion({
                    projectPath: root,
                    alias: 'temporg',
                    versionDescriptor: versionDescriptor(
                        'Active_Customer',
                        1,
                        'id-1'
                    ),
                    execAsync: async () => ({
                        stdout: buildRetrieveSuccessJson(
                            'force-app/main/default/flows/Active_Customer-1.flow-meta.xml'
                        )
                    })
                });
            } catch (error) {
                failed = true;
                assert.ok(error.message.includes('missing on disk'));
            }

            assert.strictEqual(failed, true);
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest('runFlowVersionRetrievalExtension retrieves multiple versions', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-version-run-')
        );
        const retrieveCalls = [];

        const discovery = {
            apiVersion: '61.0',
            versions: [
                versionDescriptor('Active_Customer', 1, 'id-1'),
                versionDescriptor('Active_Customer', 2, 'id-2'),
                versionDescriptor('Active_Customer', 3, 'id-3', {
                    flowIsLatestVersion: true
                })
            ]
        };

        const manifest = await runFlowVersionRetrievalExtension({
            projectPath: root,
            instanceUrl: 'https://example.my.salesforce.com',
            accessToken: 'token',
            alias: 'temporg',
            execAsync: async (command) => {
                retrieveCalls.push(command);
                const flows = flowsDir(root);
                await mkdir(flows, { recursive: true });

                if (command.includes('Flow:Active_Customer-1')) {
                    const relative =
                        'force-app/main/default/flows/Active_Customer-1.flow-meta.xml';
                    await writeFile(
                        path.join(flows, 'Active_Customer-1.flow-meta.xml'),
                        '<Flow>v1</Flow>',
                        'utf8'
                    );

                    return { stdout: buildRetrieveSuccessJson(relative) };
                }

                if (command.includes('Flow:Active_Customer-2')) {
                    const relative =
                        'force-app/main/default/flows/Active_Customer-2.flow-meta.xml';
                    await writeFile(
                        path.join(flows, 'Active_Customer-2.flow-meta.xml'),
                        '<Flow>v2</Flow>',
                        'utf8'
                    );

                    return { stdout: buildRetrieveSuccessJson(relative) };
                }

                if (command.includes('Flow:Active_Customer-3')) {
                    const relative =
                        'force-app/main/default/flows/Active_Customer.flow-meta.xml';
                    await writeFile(
                        path.join(flows, 'Active_Customer.flow-meta.xml'),
                        '<Flow>v3</Flow>',
                        'utf8'
                    );

                    return { stdout: buildRetrieveSuccessJson(relative) };
                }

                return { stdout: '{"status":0,"result":{"files":[]}}' };
            },
            discoverFlowVersionsFn: async () => discovery
        });

        assert.strictEqual(retrieveCalls.length, 3);
        assert.strictEqual(manifest.artifactCount, 3);

        const v1 = await fs.promises.readFile(
            path.join(flowsDir(root), 'Active_Customer-1.flow-meta.xml'),
            'utf8'
        );
        const v2 = await fs.promises.readFile(
            path.join(flowsDir(root), 'Active_Customer-2.flow-meta.xml'),
            'utf8'
        );
        const v3 = await fs.promises.readFile(
            path.join(flowsDir(root), 'Active_Customer-3.flow-meta.xml'),
            'utf8'
        );

        assert.ok(v1.includes('v1'));
        assert.ok(v2.includes('v2'));
        assert.ok(v3.includes('v3'));
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest(
        'runFlowVersionRetrievalExtension records failure for one bad version',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-version-partial-')
            );

            const discovery = {
                apiVersion: '61.0',
                versions: [
                    versionDescriptor('Active_Customer', 1, 'id-1'),
                    versionDescriptor('Active_Customer', 2, 'id-2')
                ]
            };

            let thrown = null;

            try {
                await runFlowVersionRetrievalExtension({
                    projectPath: root,
                    instanceUrl: 'https://example.my.salesforce.com',
                    accessToken: 'token',
                    alias: 'temporg',
                    execAsync: async (command) => {
                        const flows = flowsDir(root);
                        await mkdir(flows, { recursive: true });

                        if (command.includes('Flow:Active_Customer-1')) {
                            const relative =
                                'force-app/main/default/flows/Active_Customer-1.flow-meta.xml';
                            await writeFile(
                                path.join(
                                    flows,
                                    'Active_Customer-1.flow-meta.xml'
                                ),
                                '<Flow>v1</Flow>',
                                'utf8'
                            );

                            return {
                                stdout: buildRetrieveSuccessJson(relative)
                            };
                        }

                        throw new Error('CLI retrieve failed');
                    },
                    discoverFlowVersionsFn: async () => discovery
                });
            } catch (error) {
                thrown = error;
            }

            assert.ok(thrown);
            assert.strictEqual(
                thrown.code,
                'FLOW_VERSION_RETRIEVAL_PARTIAL_FAILURE'
            );
            assert.strictEqual(thrown.failures.length, 1);

            const manifestRaw = await fs.promises.readFile(
                path.join(
                    root,
                    '.metadata-backup',
                    'flow-version-artifacts.json'
                ),
                'utf8'
            );
            const manifest = JSON.parse(manifestRaw);

            assert.strictEqual(manifest.artifactCount, 1);
            assert.strictEqual(manifest.failureCount, 1);
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest(
        'unchanged on-disk file without CLI report does not satisfy retrieve',
        async () => {
            const root = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'flow-version-unchanged-')
            );
            const flows = flowsDir(root);

            await mkdir(flows, { recursive: true });
            await writeFile(
                path.join(flows, 'Active_Customer-1.flow-meta.xml'),
                '<Flow>stale</Flow>',
                'utf8'
            );

            let failed = false;

            try {
                await retrieveSingleFlowVersion({
                    projectPath: root,
                    alias: 'temporg',
                    versionDescriptor: versionDescriptor(
                        'Active_Customer',
                        1,
                        'id-1'
                    ),
                    execAsync: async () => ({
                        stdout: '{"status":0,"result":{"files":[]}}'
                    })
                });
            } catch (error) {
                failed = true;
                assert.ok(error.message.includes('did not report'));
            }

            assert.strictEqual(failed, true);
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );
})();
