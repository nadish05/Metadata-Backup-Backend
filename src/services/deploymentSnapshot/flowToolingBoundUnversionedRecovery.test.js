'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    retrieveExactVersionQualifiedFlowArtifact,
    createDestinationMetadataRetriever,
    FLOW_DESTINATION_VERSION_NOT_RETRIEVED
} = require('./destinationMetadataRetriever.service');
const {
    validateToolingBoundUnversionedLatestIdentity,
    attemptToolingBoundUnversionedLatestRecovery,
    TOOLING_BOUND_UNVERSIONED_LATEST
} = require('./flowToolingBoundUnversionedRecovery.service');
const {
    packMemberFiles
} = require('./destinationMemberArtifact.service');
const {
    applyCanonicalFlowSnapshotPackPaths
} = require('../flowMetadata/flowMemberIdentity.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    buildRetrieveSuccessJson
} = require('../retrieval/flowVersionRetrieval.service');

const METADATA_NAME = 'Check_Amount-4';
const FLOW_V4_PATH =
    'force-app/main/default/flows/Check_Amount-4.flow-meta.xml';
const FLOW_UNVERSIONED_PATH =
    'force-app/main/default/flows/Check_Amount.flow-meta.xml';

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

function discoveryFixture(overrides = {}) {
    const flowId = overrides.flowId || '301NS00003Eogp1YAB';
    const latestVersionId = overrides.latestVersionId ?? flowId;
    const versionNumber = overrides.versionNumber ?? 4;
    const latestVersionNumber = overrides.latestVersionNumber ?? versionNumber;
    const active = overrides.active === true;

    return {
        apiVersion: '61.0',
        definitions: [
            {
                developerName: 'Check_Amount',
                latestVersionId,
                latestVersionNumber,
                activeVersionId: active ? flowId : '301ACTIVE'
            }
        ],
        versions: overrides.versions || [
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: versionNumber,
                sourceFlowVersionId: flowId,
                definitionLatestVersionId: latestVersionId,
                flowVersionStatus: active ? 'Active' : 'Draft',
                flowIsLatestVersion: flowId === latestVersionId,
                flowIsActiveVersion: active
            }
        ]
    };
}

function exactVersionDescriptor(discovery) {
    return discovery.versions[0];
}

(async () => {
    await runTest('A. Azure reproduction — tooling-bound unversioned recovery succeeds', async () => {
        const workspace = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-tooling-bound-')
        );
        const unversionedBytes = Buffer.from(
            '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><status>Draft</status></Flow>',
            'utf8'
        );
        const unversionedAbsolute = path.join(
            workspace,
            ...FLOW_UNVERSIONED_PATH.split('/')
        );
        await fs.promises.mkdir(path.dirname(unversionedAbsolute), {
            recursive: true
        });
        await fs.promises.writeFile(unversionedAbsolute, unversionedBytes);

        const discovery = discoveryFixture();
        const result = await retrieveExactVersionQualifiedFlowArtifact({
            workspacePath: workspace,
            alias: 'alias',
            metadataName: METADATA_NAME,
            accessToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            execAsync: async () => ({
                stdout: buildRetrieveSuccessJson(FLOW_UNVERSIONED_PATH)
            }),
            discoverFlowVersionsFn: async () => discovery,
            retrieveSingleFlowVersionFn: async () => {
                throw new Error(
                    'Retrieve for Flow:Check_Amount-4 did not report a version-qualified filename for strict version identity (correlation=unversioned_filename).'
                );
            }
        });

        assert.strictEqual(
            result.exactVersionRecovery.recoveryOutcome,
            'SUCCEEDED'
        );
        assert.strictEqual(
            result.exactVersionRecovery.retrievedArtifactCorrelation,
            TOOLING_BOUND_UNVERSIONED_LATEST
        );

        const expectedPack = packMemberFiles(
            applyCanonicalFlowSnapshotPackPaths(
                [{ relativePath: FLOW_V4_PATH, bytes: unversionedBytes }],
                METADATA_NAME
            )
        );
        assert.strictEqual(hashBytes(result.artifactBytes), hashBytes(expectedPack));

        const persisted = await fs.promises.readFile(
            path.join(workspace, ...FLOW_V4_PATH.split('/'))
        );
        assert.ok(persisted.equals(unversionedBytes));
        await fs.promises.rm(workspace, { recursive: true, force: true });
    });

    await runTest('B. requested version is not latest — recovery fails closed', async () => {
        const workspace = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-tooling-not-latest-')
        );
        const discovery = discoveryFixture({
            flowId: '301V3',
            latestVersionId: '301V4',
            versionNumber: 3,
            latestVersionNumber: 4,
            versions: [
                {
                    flowDefinitionDeveloperName: 'Check_Amount',
                    sourceFlowVersionNumber: 3,
                    sourceFlowVersionId: '301V3',
                    definitionLatestVersionId: '301V4',
                    flowVersionStatus: 'Draft',
                    flowIsLatestVersion: false,
                    flowIsActiveVersion: false
                }
            ]
        });
        const parsed = {
            definitionDeveloperName: 'Check_Amount',
            sourceVersionNumber: 3,
            isVersionQualified: true
        };

        const result = await attemptToolingBoundUnversionedLatestRecovery({
            workspacePath: workspace,
            metadataName: 'Check_Amount-3',
            parsed,
            discovery,
            exactVersion: exactVersionDescriptor(discovery),
            retrievedFiles: [
                {
                    relativePath: FLOW_UNVERSIONED_PATH,
                    bytes: Buffer.from('<Flow/>', 'utf8')
                }
            ]
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(
            result.reason,
            'FLOW_ID_NOT_DEFINITION_LATEST_VERSION_ID'
        );
        await fs.promises.rm(workspace, { recursive: true, force: true });
    });

    await runTest('C. LatestVersionId mismatch — recovery fails closed', async () => {
        const discovery = discoveryFixture({
            flowId: '301V4',
            latestVersionId: '301OTHER'
        });
        const parsed = {
            definitionDeveloperName: 'Check_Amount',
            sourceVersionNumber: 4,
            isVersionQualified: true
        };
        const result = validateToolingBoundUnversionedLatestIdentity({
            discovery,
            parsed,
            exactVersion: exactVersionDescriptor(discovery)
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(
            result.reason,
            'FLOW_ID_NOT_DEFINITION_LATEST_VERSION_ID'
        );
    });

    await runTest('D. duplicate Tooling rows — recovery fails closed', async () => {
        const discovery = discoveryFixture({
            versions: [
                {
                    flowDefinitionDeveloperName: 'Check_Amount',
                    sourceFlowVersionNumber: 4,
                    sourceFlowVersionId: '301A',
                    definitionLatestVersionId: '301A',
                    flowVersionStatus: 'Draft',
                    flowIsLatestVersion: true,
                    flowIsActiveVersion: false
                },
                {
                    flowDefinitionDeveloperName: 'Check_Amount',
                    sourceFlowVersionNumber: 4,
                    sourceFlowVersionId: '301B',
                    definitionLatestVersionId: '301A',
                    flowVersionStatus: 'Draft',
                    flowIsLatestVersion: false,
                    flowIsActiveVersion: false
                }
            ]
        });
        const parsed = {
            definitionDeveloperName: 'Check_Amount',
            sourceVersionNumber: 4,
            isVersionQualified: true
        };
        const result = validateToolingBoundUnversionedLatestIdentity({
            discovery,
            parsed,
            exactVersion: discovery.versions[0]
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'AMBIGUOUS_DESTINATION_FLOW_VERSION');
    });

    await runTest('E. conflicting version-qualified workspace file — fails closed', async () => {
        const discovery = discoveryFixture();
        const parsed = {
            definitionDeveloperName: 'Check_Amount',
            sourceVersionNumber: 4,
            isVersionQualified: true
        };
        const result = await attemptToolingBoundUnversionedLatestRecovery({
            workspacePath: os.tmpdir(),
            metadataName: METADATA_NAME,
            parsed,
            discovery,
            exactVersion: exactVersionDescriptor(discovery),
            retrievedFiles: [
                {
                    relativePath: FLOW_UNVERSIONED_PATH,
                    bytes: Buffer.from('<Flow/>', 'utf8')
                },
                {
                    relativePath: FLOW_V4_PATH,
                    bytes: Buffer.from('<Flow/>', 'utf8')
                }
            ]
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'CONFLICTING_VERSION_QUALIFIED_FILES');
    });

    await runTest('F. missing LatestVersionId — fails closed', async () => {
        const discovery = discoveryFixture({ latestVersionId: null });
        discovery.definitions[0].latestVersionId = null;
        const parsed = {
            definitionDeveloperName: 'Check_Amount',
            sourceVersionNumber: 4,
            isVersionQualified: true
        };
        const result = validateToolingBoundUnversionedLatestIdentity({
            discovery,
            parsed,
            exactVersion: exactVersionDescriptor(discovery)
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'MISSING_DEFINITION_LATEST_VERSION_ID');
    });

    await runTest('G. unversioned bytes preserved exactly during recovery', async () => {
        const workspace = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-tooling-bytes-')
        );
        const bytes = Buffer.from('<?xml version="1.0"?>\n<Flow><status>Draft</status></Flow>\n', 'utf8');
        const discovery = discoveryFixture();
        const parsed = {
            definitionDeveloperName: 'Check_Amount',
            sourceVersionNumber: 4,
            isVersionQualified: true
        };
        const result = await attemptToolingBoundUnversionedLatestRecovery({
            workspacePath: workspace,
            metadataName: METADATA_NAME,
            parsed,
            discovery,
            exactVersion: exactVersionDescriptor(discovery),
            retrievedFiles: [{ relativePath: FLOW_UNVERSIONED_PATH, bytes }]
        });
        assert.strictEqual(result.ok, true);
        const onDisk = await fs.promises.readFile(
            path.join(workspace, ...FLOW_V4_PATH.split('/'))
        );
        assert.ok(onDisk.equals(bytes));
        await fs.promises.rm(workspace, { recursive: true, force: true });
    });

    await runTest('H. strict version-qualified recovery still succeeds unchanged', async () => {
        const workspace = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-tooling-strict-')
        );
        const versionedBytes = Buffer.from('<Flow versioned="true"/>', 'utf8');
        const versionedAbsolute = path.join(
            workspace,
            ...FLOW_V4_PATH.split('/')
        );
        await fs.promises.mkdir(path.dirname(versionedAbsolute), {
            recursive: true
        });
        await fs.promises.writeFile(versionedAbsolute, versionedBytes);

        const discovery = discoveryFixture();
        const result = await retrieveExactVersionQualifiedFlowArtifact({
            workspacePath: workspace,
            alias: 'alias',
            metadataName: METADATA_NAME,
            accessToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            execAsync: async () => ({
                stdout: buildRetrieveSuccessJson(FLOW_V4_PATH)
            }),
            discoverFlowVersionsFn: async () => discovery,
            retrieveSingleFlowVersionFn: async () => ({
                ...exactVersionDescriptor(discovery),
                retrievedArtifactPath: FLOW_V4_PATH,
                retrievedArtifactCorrelation: 'versioned_filename',
                workspaceArtifactPath: FLOW_V4_PATH,
                artifactSha256: hashBytes(versionedBytes)
            })
        });

        assert.strictEqual(
            result.exactVersionRecovery.retrievedArtifactCorrelation,
            'versioned_filename'
        );
        await fs.promises.rm(workspace, { recursive: true, force: true });
    });

    await runTest('I. non-Flow retrieve path unaffected', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tooling-apex-'));
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

                const workspaces = fs
                    .readdirSync(workRoot)
                    .filter((name) => name.startsWith('dest-snapshot-'));
                const target = path.join(workRoot, workspaces[0], clsPath);
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                await fs.promises.writeFile(target, clsBytes);
                return {
                    stdout: JSON.stringify({ status: 0, result: { files: [] } }),
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
            result.flowExactVersionArtifactVerified,
            false
        );
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });

    await runTest('K. failed recovery does not mark flowExactVersionArtifactVerified', async () => {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tooling-fail-'));
        const unversionedBytes = Buffer.from('<Flow/>', 'utf8');
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
            discoverFlowVersions: async () =>
                discoveryFixture({ latestVersionId: '301OTHER', flowId: '301V4' }),
            execAsync: async (command) => {
                if (String(command).includes('logout')) {
                    return { stdout: '', stderr: '' };
                }

                const workspaces = fs
                    .readdirSync(workRoot)
                    .filter((name) => name.startsWith('dest-snapshot-'));
                const target = path.join(
                    workRoot,
                    workspaces[0],
                    FLOW_UNVERSIONED_PATH
                );
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                await fs.promises.writeFile(target, unversionedBytes);
                return {
                    stdout: JSON.stringify({ status: 0, result: { files: [] } }),
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
                    metadataName: METADATA_NAME,
                    requireExactVersionQualifiedFlowArtifact: true
                }),
            (error) => error.code === FLOW_DESTINATION_VERSION_NOT_RETRIEVED
        );
        await fs.promises.rm(workRoot, { recursive: true, force: true });
    });
})();
