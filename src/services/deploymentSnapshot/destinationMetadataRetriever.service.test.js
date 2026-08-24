'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createDestinationMetadataRetriever
} = require('./destinationMetadataRetriever.service');
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

(async () => {
    await runTest('retriever source does not use retrieveMetadataInternal', () => {
        const source = fs.readFileSync(
            path.join(__dirname, 'destinationMetadataRetriever.service.js'),
            'utf8'
        );

        assert.ok(!source.includes('retrieveMetadataInternal'));
        assert.ok(source.includes('sf project retrieve start'));
        assert.ok(source.includes('dest-snapshot-'));
    });

    await runTest('retrieves member bytes then deletes the temp workspace', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r4-retr-ok-'));
        const clsBytes = Buffer.from('public class AccountService {\r\n}\n', 'utf8');
        let retrieveCommand = '';

        const retriever = createDestinationMetadataRetriever({
            tmpdir: () => workRoot,
            ensureSfdxProject: async (workspacePath) => {
                await fs.promises.writeFile(
                    path.join(workspacePath, 'sfdx-project.json'),
                    '{}'
                );
                return { success: true };
            },
            refreshAccessToken: async () => ({
                accessToken: 'access-token-not-for-logs',
                instanceUrl: 'https://example.my.salesforce.com'
            }),
            loginSfOrg: async () => {},
            execAsync: async (command) => {
                if (String(command).includes('logout')) {
                    return { stdout: '', stderr: '' };
                }

                retrieveCommand = String(command);
                await writeMemberFile(
                    workRoot,
                    'force-app/main/default/classes/AccountService.cls',
                    clsBytes
                );
                return { stdout: '{}', stderr: '' };
            }
        });

        const result = await retriever.retrieveDestinationMember({
            refreshToken: 'refresh-secret',
            instanceUrl: 'https://example.my.salesforce.com',
            metadataType: 'ApexClass',
            metadataName: 'AccountService'
        });

        assert.ok(retrieveCommand.includes('-m'));
        assert.ok(retrieveCommand.includes('ApexClass:AccountService'));
        assert.ok(!retrieveCommand.includes('refresh-secret'));
        assert.deepStrictEqual(
            unpackMemberFiles(result.artifactBytes)[0].bytes,
            clsBytes
        );
        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);

        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('cleans up the temp workspace when retrieve fails', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r4-retr-fail-'));

        const retriever = createDestinationMetadataRetriever({
            tmpdir: () => workRoot,
            ensureSfdxProject: async (workspacePath) => {
                await fs.promises.writeFile(
                    path.join(workspacePath, 'sfdx-project.json'),
                    '{}'
                );
                return { success: true };
            },
            refreshAccessToken: async () => ({
                accessToken: 'access-token',
                instanceUrl: 'https://example.my.salesforce.com'
            }),
            loginSfOrg: async () => {},
            execAsync: async (command) => {
                if (String(command).includes('logout')) {
                    return { stdout: '', stderr: '' };
                }

                const error = new Error('retrieve failed');
                error.stdout = 'cli error';
                throw error;
            }
        });

        await assert.rejects(
            () =>
                retriever.retrieveDestinationMember({
                    refreshToken: 'refresh-secret',
                    instanceUrl: 'https://example.my.salesforce.com',
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService'
                }),
            /member retrieval returned no artifact/
        );

        assert.deepStrictEqual(listSnapshotWorkspaces(workRoot), []);
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });
})();
