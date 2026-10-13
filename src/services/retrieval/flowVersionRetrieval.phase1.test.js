'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const {
    correlateRetrieveResult,
    diffFlowSnapshots,
    hashBytes,
    persistVersionArtifact,
    retrieveSingleFlowVersion,
    runFlowVersionRetrievalExtension
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

function versionDescriptor(developerName, versionNumber, id) {
    return {
        flowDefinitionDeveloperName: developerName,
        sourceFlowVersionNumber: versionNumber,
        sourceFlowVersionId: id,
        requestedMetadataMemberName: `${developerName}-${versionNumber}`,
        requestedMetadataMember: `Flow:${developerName}-${versionNumber}`
    };
}

(async () => {
    await runTest('correlateRetrieveResult accepts unversioned filename delta', () => {
        const bytes = Buffer.from('<Flow>v2</Flow>', 'utf8');
        const correlation = correlateRetrieveResult({
            developerName: 'Get_Customer_Details',
            versionNumber: 2,
            changedFiles: [
                {
                    fileName: 'Get_Customer_Details.flow-meta.xml',
                    bytes,
                    relativePath:
                        'force-app/main/default/flows/Get_Customer_Details.flow-meta.xml'
                }
            ],
            beforeSnapshot: new Map()
        });

        assert.strictEqual(correlation.correlation, 'unversioned_filename');
        assert.strictEqual(hashBytes(correlation.sourceBytes), hashBytes(bytes));
    });

    await runTest('correlateRetrieveResult fails closed on ambiguous deltas', () => {
        const correlation = correlateRetrieveResult({
            developerName: 'Get_Customer_Details',
            versionNumber: 2,
            changedFiles: [
                {
                    fileName: 'Get_Customer_Details-1.flow-meta.xml',
                    bytes: Buffer.from('a')
                },
                {
                    fileName: 'Get_Customer_Details-2.flow-meta.xml',
                    bytes: Buffer.from('b')
                }
            ],
            beforeSnapshot: new Map()
        });

        assert.strictEqual(correlation, null);
    });

    await runTest('persistVersionArtifact writes canonical versioned path', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-version-persist-')
        );
        const bytes = Buffer.from('<Flow>one</Flow>', 'utf8');

        const persisted = await persistVersionArtifact({
            projectPath: root,
            developerName: 'Get_Customer_Details',
            versionNumber: 1,
            sourceBytes: bytes
        });

        assert.strictEqual(
            persisted.workspaceArtifactPath,
            'force-app/main/default/flows/Get_Customer_Details-1.flow-meta.xml'
        );

        const onDisk = await fs.promises.readFile(
            path.join(root, ...persisted.workspaceArtifactPath.split('/'))
        );

        assert.strictEqual(hashBytes(onDisk), hashBytes(bytes));
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('retrieveSingleFlowVersion maps unversioned retrieve to versioned artifact', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-version-retrieve-')
        );
        const flowsDir = path.join(
            root,
            'force-app',
            'main',
            'default',
            'flows'
        );

        await mkdir(flowsDir, { recursive: true });

        const execAsync = async () => ({
            stdout: JSON.stringify({ status: 0 })
        });

        const result = await retrieveSingleFlowVersion({
            projectPath: root,
            alias: 'temporg',
            versionDescriptor: versionDescriptor('Get_Customer_Details', 2, '2xx'),
            execAsync: async (command) => {
                await writeFile(
                    path.join(flowsDir, 'Get_Customer_Details.flow-meta.xml'),
                    '<Flow>version-2</Flow>',
                    'utf8'
                );

                return { stdout: '{}' };
            }
        });

        assert.strictEqual(
            result.workspaceArtifactPath,
            'force-app/main/default/flows/Get_Customer_Details-2.flow-meta.xml'
        );
        assert.strictEqual(result.retrievedArtifactCorrelation, 'unversioned_filename');

        const v1Exists = await fs.promises
            .stat(
                path.join(
                    flowsDir,
                    'Get_Customer_Details-2.flow-meta.xml'
                )
            )
            .then(() => true)
            .catch(() => false);

        assert.strictEqual(v1Exists, true);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('runFlowVersionRetrievalExtension retrieves every discovered version', async () => {
        const root = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-version-run-')
        );
        const retrieveCalls = [];

        const discovery = {
            apiVersion: '61.0',
            versions: [
                versionDescriptor('Get_Customer_Details', 1, 'id-1'),
                versionDescriptor('Get_Customer_Details', 2, 'id-2')
            ]
        };

        const manifest = await runFlowVersionRetrievalExtension({
            projectPath: root,
            instanceUrl: 'https://example.my.salesforce.com',
            accessToken: 'token',
            alias: 'temporg',
            execAsync: async (command) => {
                retrieveCalls.push(command);
                const flowsDir = path.join(
                    root,
                    'force-app',
                    'main',
                    'default',
                    'flows'
                );
                await mkdir(flowsDir, { recursive: true });

                if (command.includes('Flow:Get_Customer_Details-1')) {
                    await writeFile(
                        path.join(
                            flowsDir,
                            'Get_Customer_Details-1.flow-meta.xml'
                        ),
                        '<Flow>v1</Flow>',
                        'utf8'
                    );
                }

                if (command.includes('Flow:Get_Customer_Details-2')) {
                    await writeFile(
                        path.join(
                            flowsDir,
                            'Get_Customer_Details.flow-meta.xml'
                        ),
                        '<Flow>v2</Flow>',
                        'utf8'
                    );
                }

                return { stdout: '{}' };
            },
            discoverFlowVersionsFn: async () => discovery
        });

        assert.strictEqual(retrieveCalls.length, 2);
        assert.strictEqual(manifest.artifactCount, 2);

        const v1 = await fs.promises.readFile(
            path.join(
                root,
                'force-app',
                'main',
                'default',
                'flows',
                'Get_Customer_Details-1.flow-meta.xml'
            ),
            'utf8'
        );
        const v2 = await fs.promises.readFile(
            path.join(
                root,
                'force-app',
                'main',
                'default',
                'flows',
                'Get_Customer_Details-2.flow-meta.xml'
            ),
            'utf8'
        );

        assert.ok(v1.includes('v1'));
        assert.ok(v2.includes('v2'));
        assert.notStrictEqual(v1, v2);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('diffFlowSnapshots detects hash changes', () => {
        const before = new Map([
            [
                'Get_Customer_Details.flow-meta.xml',
                {
                    sha256: hashBytes(Buffer.from('a'))
                }
            ]
        ]);
        const after = new Map([
            [
                'Get_Customer_Details.flow-meta.xml',
                {
                    fileName: 'Get_Customer_Details.flow-meta.xml',
                    bytes: Buffer.from('b'),
                    sha256: hashBytes(Buffer.from('b'))
                }
            ]
        ]);

        const diff = diffFlowSnapshots(before, after);

        assert.strictEqual(diff.length, 1);
    });
})();
