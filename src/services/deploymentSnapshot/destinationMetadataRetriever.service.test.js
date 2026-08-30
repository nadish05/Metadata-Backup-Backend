'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createDestinationMetadataRetriever,
    buildExpectedMemberSourcePaths,
    buildRetrieveDiagnosticRecord,
    summarizeRetrieveCliOutput
} = require('./destinationMetadataRetriever.service');
const { ensureSfdxProject } = require('../sfdxProject.service');
const { unpackMemberFiles } = require('./destinationMemberArtifact.service');

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

function captureConsoleLogs(fn) {
    const logs = [];
    const originalLog = console.log;

    console.log = (...args) => {
        logs.push(
            args
                .map((arg) =>
                    typeof arg === 'string' ? arg : JSON.stringify(arg)
                )
                .join(' ')
        );
    };

    return Promise.resolve()
        .then(fn)
        .then((result) => ({ logs, result, error: null }))
        .catch((error) => ({ logs, result: null, error }))
        .finally(() => {
            console.log = originalLog;
        });
}

function buildRetrieverHarness(workRoot, execAsyncImpl) {
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
            accessToken: 'access-token-not-for-logs',
            instanceUrl: 'https://example.my.salesforce.com'
        }),
        loginSfOrg: async () => {},
        execAsync: execAsyncImpl
    });
}

(async () => {
    await runTest('bootstrap creates the force-app package directory referenced by sfdx-project.json', async () => {
        const workRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'p0r1512-bootstrap-')
        );
        const workspacePath = path.join(workRoot, 'dest-snapshot-bootstrap');

        await fs.promises.mkdir(workspacePath, { recursive: true });

        const bootstrap = await ensureSfdxProject(workspacePath, {
            sourceApiVersion: '67.0'
        });

        assert.strictEqual(bootstrap.success, true);
        assert.ok(
            fs.existsSync(path.join(workspacePath, 'force-app')),
            'force-app package directory must exist after bootstrap'
        );
        assert.ok(
            fs.statSync(path.join(workspacePath, 'force-app')).isDirectory()
        );
        assert.ok(
            !fs.existsSync(
                path.join(
                    workspacePath,
                    'force-app',
                    'main',
                    'default',
                    'classes'
                )
            ),
            'nested source directories are not required before retrieve'
        );

        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('retrieve uses real bootstrap and creates force-app before CLI retrieve', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r1512-retr-bootstrap-'));
        const clsBytes = Buffer.from('public class DemoModifiedClass {\n}\n', 'utf8');
        let retrieveCommand = '';
        let forceAppExistedBeforeRetrieve = false;

        const retriever = createDestinationMetadataRetriever({
            tmpdir: () => workRoot,
            refreshAccessToken: async () => ({
                accessToken: 'access-token-not-for-logs',
                instanceUrl: 'https://example.my.salesforce.com'
            }),
            loginSfOrg: async () => {},
            execAsync: async (command) => {
                if (String(command).includes('logout')) {
                    return { stdout: '', stderr: '' };
                }

                const workspaces = listSnapshotWorkspaces(workRoot);
                assert.strictEqual(workspaces.length, 1);
                forceAppExistedBeforeRetrieve = fs.existsSync(
                    path.join(workspaces[0], 'force-app')
                );

                retrieveCommand = String(command);
                await writeMemberFile(
                    workRoot,
                    'force-app/main/default/classes/DemoModifiedClass.cls',
                    clsBytes
                );

                return {
                    stdout: JSON.stringify({ status: 0, result: { files: [] } }),
                    stderr: ''
                };
            }
        });

        const result = await retriever.retrieveDestinationMember({
            refreshToken: 'refresh-secret',
            instanceUrl: 'https://example.my.salesforce.com',
            metadataType: 'ApexClass',
            metadataName: 'DemoModifiedClass',
            sourceApiVersion: '67.0'
        });

        assert.strictEqual(forceAppExistedBeforeRetrieve, true);
        assert.ok(retrieveCommand.includes('ApexClass:DemoModifiedClass'));
        assert.deepStrictEqual(
            unpackMemberFiles(result.artifactBytes)[0].bytes,
            clsBytes
        );
        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);

        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('retriever source does not use retrieveMetadataInternal', () => {
        const source = fs.readFileSync(
            path.join(__dirname, 'destinationMetadataRetriever.service.js'),
            'utf8'
        );

        assert.ok(!source.includes('retrieveMetadataInternal'));
        assert.ok(source.includes('sf project retrieve start'));
        assert.ok(source.includes('dest-snapshot-'));
    });

    await runTest('buildExpectedMemberSourcePaths is generic for ApexClass', () => {
        const paths = buildExpectedMemberSourcePaths(
            'ApexClass',
            'DemoModifiedClass'
        );

        assert.deepStrictEqual(paths, {
            cls: 'force-app/main/default/classes/DemoModifiedClass.cls',
            metaXml:
                'force-app/main/default/classes/DemoModifiedClass.cls-meta.xml'
        });
    });

    await runTest('retrieves member bytes then deletes the temp workspace', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r4-retr-ok-'));
        const clsBytes = Buffer.from('public class AccountService {\r\n}\n', 'utf8');
        let retrieveCommand = '';

        const retriever = buildRetrieverHarness(workRoot, async (command) => {
            if (String(command).includes('logout')) {
                return { stdout: '', stderr: '' };
            }

            retrieveCommand = String(command);
            await writeMemberFile(
                workRoot,
                'force-app/main/default/classes/AccountService.cls',
                clsBytes
            );
            return {
                stdout: JSON.stringify({ status: 0, result: { files: [] } }),
                stderr: ''
            };
        });

        const { logs, result } = await captureConsoleLogs(() =>
            retriever.retrieveDestinationMember({
                refreshToken: 'refresh-secret',
                instanceUrl: 'https://example.my.salesforce.com',
                metadataType: 'ApexClass',
                metadataName: 'AccountService'
            })
        );

        assert.ok(retrieveCommand.includes('-m'));
        assert.ok(retrieveCommand.includes('ApexClass:AccountService'));
        assert.ok(!retrieveCommand.includes('refresh-secret'));
        assert.deepStrictEqual(
            unpackMemberFiles(result.artifactBytes)[0].bytes,
            clsBytes
        );
        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);

        const diagnosticLog = logs.join('\n');
        assert.ok(diagnosticLog.includes('Destination Snapshot Retrieve Diagnostic'));
        assert.ok(diagnosticLog.includes('retrievedFileCount'));
        assert.ok(
            diagnosticLog.includes(
                'force-app/main/default/classes/AccountService.cls'
            )
        );
        assert.ok(diagnosticLog.includes('"exists": true'));
        assert.ok(
            diagnosticLog.includes(
                '"relativePath": "force-app/main/default/classes/AccountService.cls"'
            )
        );

        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('execAsync throws with stderr and surfaces useful CLI error', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r4-retr-stderr-'));

        const retriever = buildRetrieverHarness(workRoot, async (command) => {
            if (String(command).includes('logout')) {
                return { stdout: '', stderr: '' };
            }

            const error = new Error('Command failed');
            error.code = 1;
            error.stdout = '';
            error.stderr = 'INVALID_CROSS_REFERENCE_KEY: No ApexClass named AccountService';
            throw error;
        });

        const { logs, error } = await captureConsoleLogs(() =>
            retriever.retrieveDestinationMember({
                refreshToken: 'refresh-secret',
                instanceUrl: 'https://example.my.salesforce.com',
                metadataType: 'ApexClass',
                metadataName: 'AccountService'
            })
        );

        assert.ok(error instanceof Error);
        assert.ok(
            error.message.includes('INVALID_CROSS_REFERENCE_KEY')
        );
        assert.ok(!/member retrieval returned no artifact\.$/.test(error.message));

        const diagnosticLog = logs.join('\n');
        assert.ok(diagnosticLog.includes('exitCode'));
        assert.ok(diagnosticLog.includes('INVALID_CROSS_REFERENCE_KEY'));
        assert.ok(!diagnosticLog.includes('refresh-secret'));
        assert.ok(!diagnosticLog.includes('access-token-not-for-logs'));

        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('execAsync throws with JSON stdout and extracts Salesforce CLI failure message', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r4-retr-json-'));

        const retriever = buildRetrieverHarness(workRoot, async (command) => {
            if (String(command).includes('logout')) {
                return { stdout: '', stderr: '' };
            }

            const error = new Error('Command failed');
            error.code = 1;
            error.stdout = JSON.stringify({
                status: 1,
                message: 'Retrieve failed',
                result: {
                    files: [],
                    failures: [
                        {
                            name: 'AccountService',
                            message: 'Entity of type ApexClass named AccountService not found'
                        }
                    ]
                }
            });
            error.stderr = '';
            throw error;
        });

        const error = await assert.rejects(
            () =>
                retriever.retrieveDestinationMember({
                    refreshToken: 'refresh-secret',
                    instanceUrl: 'https://example.my.salesforce.com',
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService'
                }),
            (thrown) => {
                assert.ok(
                    thrown.message.includes(
                        'Entity of type ApexClass named AccountService not found'
                    )
                );
                assert.ok(thrown.message.includes('CLI status 1'));
                assert.ok(
                    !/member retrieval returned no artifact\.$/.test(
                        thrown.message
                    )
                );
                return true;
            }
        );

        void error;
        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('execAsync succeeds but zero files exist and reports diagnostic zero-file state', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r4-retr-zero-'));

        const retriever = buildRetrieverHarness(workRoot, async (command) => {
            if (String(command).includes('logout')) {
                return { stdout: '', stderr: '' };
            }

            return {
                stdout: JSON.stringify({
                    status: 0,
                    result: {
                        files: [],
                        failures: [
                            {
                                message: 'No files were retrieved for ApexClass:AccountService'
                            }
                        ]
                    }
                }),
                stderr: ''
            };
        });

        const { logs, error } = await captureConsoleLogs(() =>
            retriever.retrieveDestinationMember({
                refreshToken: 'refresh-secret',
                instanceUrl: 'https://example.my.salesforce.com',
                metadataType: 'ApexClass',
                metadataName: 'AccountService'
            })
        );

        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('retrieved file count = 0'));
        assert.ok(error.message.includes('CLI status 0'));
        assert.ok(
            error.message.includes(
                'No files were retrieved for ApexClass:AccountService'
            )
        );
        assert.ok(
            error.message.includes(
                'expected source paths: cls=missing (force-app/main/default/classes/AccountService.cls)'
            )
        );

        const diagnosticLog = logs.join('\n');
        assert.ok(diagnosticLog.includes('"retrievedFileCount": 0'));
        assert.ok(diagnosticLog.includes('"exists": false'));

        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('diagnostic output does not expose credentials or tokens', async () => {
        const diagnostic = buildRetrieveDiagnosticRecord({
            metadataType: 'ApexClass',
            metadataName: 'SecretClass',
            alias: 'dest-snapshot-123',
            workspacePath: '/tmp/dest-snapshot-abc',
            retrieveCommand:
                'cd "/tmp/dest-snapshot-abc" && sf project retrieve start --target-org "dest-snapshot-123" -m "ApexClass:SecretClass" --json',
            sourceApiVersion: '61.0',
            exitCode: 1,
            stdout: JSON.stringify({
                status: 1,
                message: 'failed'
            }),
            stderr:
                'Authorization: Bearer abc.def.ghi refresh_token="refresh-secret-value" accessToken="access-token-value"',
            summary: summarizeRetrieveCliOutput(
                JSON.stringify({ status: 1, message: 'failed' })
            ),
            retrievedFiles: [],
            workspaceTopLevel: ['sfdx-project.json'],
            expectedPathChecks: {
                cls: {
                    relativePath:
                        'force-app/main/default/classes/SecretClass.cls',
                    exists: false
                }
            }
        });

        const serialized = JSON.stringify(diagnostic);

        assert.ok(!serialized.includes('refresh-secret-value'));
        assert.ok(!serialized.includes('access-token-value'));
        assert.ok(!serialized.includes('Bearer abc.def.ghi'));
        assert.ok(serialized.includes('[REDACTED]'));
    });

    await runTest('cleans up the temp workspace when retrieve fails', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r4-retr-fail-'));

        const retriever = buildRetrieverHarness(workRoot, async (command) => {
            if (String(command).includes('logout')) {
                return { stdout: '', stderr: '' };
            }

            const error = new Error('retrieve failed');
            error.code = 1;
            error.stdout = '';
            error.stderr = 'retrieve failed at CLI layer';
            throw error;
        });

        await assert.rejects(
            () =>
                retriever.retrieveDestinationMember({
                    refreshToken: 'refresh-secret',
                    instanceUrl: 'https://example.my.salesforce.com',
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService'
                }),
            /retrieve failed at CLI layer/
        );

        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });
})();
