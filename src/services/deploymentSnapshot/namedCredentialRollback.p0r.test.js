'use strict';

const assert = require('assert');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildExistenceQuery,
    usesToolingApi
} = require('../destinationInventory/destinationExistenceQueries');
const {
    isCaptureAllowlisted
} = require('./destinationSnapshotMapper.service');
const {
    buildExpectedMemberSourcePaths,
    selectLogicalMemberFiles
} = require('./destinationMetadataRetriever.service');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    EXPECTED_AFTER_REPRESENTATION
} = require('./snapshot.types');
const {
    compareNewMemberForDeleteRollback,
    compareMemberExpectedAfterDrift,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');
const {
    isDeleteRollbackEligibleMember,
    isModifiedRollbackEligibleMember
} = require('./snapshotRollbackEligibility.service');
const { generateDestructiveChangesXml } = require('../packageXml.service');
const { buildDeleteRollbackWorkspace } = require('./destructiveRollbackWorkspace.service');
const { buildMixedRollbackWorkspace } = require('./mixedRollbackWorkspace.service');
const {
    createSnapshotCaptureService
} = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    DESTINATION_STATE,
    buildDestinationInventory
} = require('../destinationInventory/destinationInventoryBuilder.service');
const { collectExpectedAfterArtifact } = require('./expectedAfterArtifact.service');
const {
    partitionRollbackExecutionMembers
} = require('./rollbackMemberExecutionPolicy.service');

const METADATA_TYPE = 'NamedCredential';
const METADATA_NAME = 'Backup_API';
const FILE_PATH =
    'force-app/main/default/namedCredentials/Backup_API.namedCredential-meta.xml';

const NC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Backup API Fixture</label>
    <namedCredentialParameters>
        <parameterName>Url</parameterName>
        <parameterType>Url</parameterType>
        <parameterValue>https://example.test.invalid/api</parameterValue>
    </namedCredentialParameters>
    <externalCredential>Backup_External_Credential</externalCredential>
</NamedCredential>`;

const NC_XML_MODIFIED = NC_XML.replace(
    'Backup API Fixture',
    'Backup API Fixture Updated'
);

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

function packNamedCredentialXml(xml) {
    return packMemberFiles([
        {
            relativePath: FILE_PATH,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

const API_VERSIONS = [{ version: '64.0' }];

function stubRestQuery({ totalSize, records = [], fail = false }) {
    const originalGet = axios.get;
    const requestedUrls = [];

    axios.get = async (url) => {
        if (url.endsWith('/services/data/')) {
            return { status: 200, data: API_VERSIONS };
        }

        requestedUrls.push(url);

        if (fail) {
            throw new Error('Simulated NamedCredential query failure');
        }

        return {
            status: 200,
            data: { totalSize, done: true, records }
        };
    };

    return {
        requestedUrls,
        restore() {
            axios.get = originalGet;
        }
    };
}

(async () => {
    await runTest('TEST 1 — NamedCredential existence query uses REST DeveloperName', () => {
        assert.strictEqual(usesToolingApi(METADATA_TYPE), false);
        const soql = buildExistenceQuery(METADATA_TYPE, METADATA_NAME);

        assert.ok(soql.includes("DeveloperName = 'Backup_API'"));
        assert.ok(soql.includes('FROM NamedCredential'));
    });

    await runTest('TEST 2 — NamedCredential is in snapshot allowlist', () => {
        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
    });

    await runTest('TEST 3 — exact NamedCredential file path is resolved', () => {
        const paths = buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME);

        assert.strictEqual(paths.logical, FILE_PATH);
    });

    await runTest('TEST 4 — logical retrieve selects only the target NamedCredential file', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(NC_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/namedCredentials/Other_API.namedCredential-meta.xml',
                    bytes: Buffer.from('<NamedCredential/>')
                },
                {
                    relativePath:
                        'force-app/main/default/classes/AccountService.cls',
                    bytes: Buffer.from('class')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('TEST 5 — unrelated NamedCredential files are excluded', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(NC_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/namedCredentials/Unrelated_NC.namedCredential-meta.xml',
                    bytes: Buffer.from('<NamedCredential/>')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('TEST 6 — unrelated metadata files are excluded from logical selection', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(NC_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/externalCredentials/Backup_External_Credential.externalCredential-meta.xml',
                    bytes: Buffer.from('<ExternalCredential/>')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('TEST 7 — filePath fallback resolves namedCredentials path', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'named-credential-fallback-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, NC_XML, 'utf8');

        try {
            const result = await collectExpectedAfterArtifact({
                workspacePath,
                member: {
                    metadataType: METADATA_TYPE,
                    metadataName: METADATA_NAME,
                    filePath: null
                }
            });

            assert.strictEqual(result.files[0].relativePath, FILE_PATH);
        } finally {
            await fs.promises.rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('TEST 8 — RAW expected-after representation', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'named-credential-raw-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, NC_XML, 'utf8');

        try {
            const result = await collectExpectedAfterArtifact({
                workspacePath,
                member: {
                    metadataType: METADATA_TYPE,
                    metadataName: METADATA_NAME,
                    filePath: null
                }
            });

            assert.strictEqual(
                result.expectedAfterRepresentation,
                EXPECTED_AFTER_REPRESENTATION.RAW
            );
            assert.strictEqual(
                hashBytes(result.artifactBytes),
                result.expectedAfterHash
            );
        } finally {
            await fs.promises.rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('TEST 9 — post-delete verification expects MISSING inventory state', async () => {
        const stub = stubRestQuery({ totalSize: 0, records: [] });

        try {
            const result = await buildDestinationInventory({
                items: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get(`${METADATA_TYPE}:${METADATA_NAME}`).state,
                DESTINATION_STATE.MISSING
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 10 — NEW expected-after hash is present and stable', async () => {
        const bytes = packNamedCredentialXml(NC_XML);

        assert.ok(hashBytes(bytes));
        assert.strictEqual(hashBytes(bytes), hashBytes(packNamedCredentialXml(NC_XML)));
    });

    await runTest('TEST 11 — destructive rollback manifest contains NamedCredential member only', async () => {
        const afterBytes = packNamedCredentialXml(NC_XML);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(afterBytes)
        };

        const xml = generateDestructiveChangesXml({
            metadata: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }]
        });
        assert.match(xml, /<name>NamedCredential<\/name>/);
        assert.match(xml, /<members>Backup_API<\/members>/);
        assert.doesNotMatch(xml, /<name>ExternalCredential<\/name>/);
        assert.doesNotMatch(xml, /Backup_External_Credential/);

        const workspace = await buildDeleteRollbackWorkspace({ members: [member] });
        assert.match(
            workspace.generatedManifest.destructiveChangesXml,
            /Backup_API/
        );
        assert.doesNotMatch(
            workspace.generatedManifest.destructiveChangesXml,
            /ExternalCredential/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 12 — MODIFIED restore uses destination-before artifact bytes', async () => {
        const beforeBytes = packNamedCredentialXml(NC_XML);
        const afterBytes = packNamedCredentialXml(NC_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-nc-modified',
            artifactBytes: beforeBytes
        };

        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: 'snapshot_nc_restore' },
            members: [member],
            getArtifact: async () => beforeBytes
        });

        const restoredPath = path.join(workspace.workspacePath, FILE_PATH);
        assert.ok(fs.existsSync(restoredPath));
        assert.match(fs.readFileSync(restoredPath, 'utf8'), /Backup API Fixture/);
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /<name>NamedCredential<\/name>/
        );
        assert.match(fs.readFileSync(workspace.packageXmlPath, 'utf8'), /Backup_API/);

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 13 — MODIFIED drift DRIFT blocks rollback comparison', () => {
        const before = packNamedCredentialXml(NC_XML);
        const after = packNamedCredentialXml(NC_XML_MODIFIED);
        const third = packNamedCredentialXml(
            NC_XML.replace('example.test.invalid', 'other.test.invalid')
        );
        const result = compareMemberExpectedAfterDrift({
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            destinationBeforeHash: hashBytes(before),
            expectedAfterHash: hashBytes(after),
            expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW,
            currentDestinationHash: hashBytes(third),
            currentDestinationArtifactBytes: third
        });

        assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
    });

    await runTest('TEST 14 — UNKNOWN existence remains fail-closed', async () => {
        const stub = stubRestQuery({ fail: true });

        try {
            const result = await buildDestinationInventory({
                items: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            const entry = result.inventory.get(`${METADATA_TYPE}:${METADATA_NAME}`);
            assert.strictEqual(entry.state, DESTINATION_STATE.UNKNOWN);
            assert.notStrictEqual(entry.state, DESTINATION_STATE.MISSING);
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 15 — NamedCredential stays automatic in mixed manual partition', () => {
        const recordTypeMember = {
            metadataType: 'RecordType',
            metadataName: 'Opportunity.New_Business',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'rt-hash'
        };
        const ncMember = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(packNamedCredentialXml(NC_XML))
        };

        const partition = partitionRollbackExecutionMembers([
            recordTypeMember,
            ncMember
        ]);

        assert.strictEqual(partition.manualRollbackItems.length, 1);
        assert.strictEqual(partition.manualRollbackItems[0].metadataType, 'RecordType');
        assert.strictEqual(partition.automaticMembers.length, 1);
        assert.strictEqual(partition.automaticMembers[0].metadataType, METADATA_TYPE);
    });

    await runTest('TEST 16 — RecordType manual partition is unchanged with NamedCredential present', () => {
        const recordTypeMember = {
            metadataType: 'RecordType',
            metadataName: 'Account.Partner',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'rt-hash-2'
        };

        const partition = partitionRollbackExecutionMembers([
            recordTypeMember,
            {
                metadataType: METADATA_TYPE,
                metadataName: METADATA_NAME,
                changeClass: CHANGE_CLASS.MODIFIED,
                captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
                destinationBeforeHash: 'nc-before',
                expectedAfterHash: 'nc-after',
                artifactId: 'artifact-nc'
            }
        ]);

        assert.strictEqual(partition.manualRollbackItems.length, 1);
        assert.strictEqual(partition.manualRollbackItems[0].metadataName, 'Account.Partner');
        assert.strictEqual(partition.automaticMembers.length, 1);
    });

    await runTest('TEST 17 — CompactLayout allowlist and path resolution remain unaffected', () => {
        const compactName = 'Opportunity.Opportunity_Highlights';
        const compactPath =
            'force-app/main/default/objects/Opportunity/compactLayouts/Opportunity_Highlights.compactLayout-meta.xml';

        assert.strictEqual(isCaptureAllowlisted('CompactLayout'), true);
        assert.strictEqual(
            buildExpectedMemberSourcePaths('CompactLayout', compactName).logical,
            compactPath
        );
    });

    await runTest('TEST 18 — ExternalCredential is not automatically deleted with NamedCredential rollback', () => {
        const xml = generateDestructiveChangesXml({
            metadata: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }]
        });

        assert.doesNotMatch(xml, /<name>ExternalCredential<\/name>/);
        assert.doesNotMatch(xml, /<members>Backup_External_Credential<\/members>/);
    });

    await runTest('NEW NamedCredential delete rollback eligibility', () => {
        const afterBytes = packNamedCredentialXml(NC_XML);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(afterBytes)
        };

        assert.strictEqual(isDeleteRollbackEligibleMember(member), true);
    });

    await runTest('MODIFIED NamedCredential passes rollback eligibility', () => {
        const beforeBytes = packNamedCredentialXml(NC_XML);
        const afterBytes = packNamedCredentialXml(NC_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-nc-modified'
        };

        assert.strictEqual(isModifiedRollbackEligibleMember(member), true);
    });

    await runTest('NEW delete drift MATCH allows delete rollback', () => {
        const expectedHash = hashBytes(packNamedCredentialXml(NC_XML));
        const result = compareNewMemberForDeleteRollback({
            expectedAfterHash: expectedHash,
            currentDestinationHash: expectedHash
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest('NEW capture shape uses ABSENT_PROVEN', async () => {
        const afterBytes = packNamedCredentialXml(NC_XML);
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const ready = await capture.captureSnapshot({
            deploymentContext: {
                destinationOrgId: '00D000000000001',
                sourceOrgId: '00D000000000002'
            },
            members: [
                {
                    metadataType: METADATA_TYPE,
                    metadataName: METADATA_NAME,
                    filePath: FILE_PATH,
                    changeClass: CHANGE_CLASS.NEW,
                    expectedAfterHash: hashBytes(afterBytes)
                }
            ]
        });
        const members = await capture.getMembers(ready.snapshotId);
        const member = members[0];

        assert.strictEqual(member.changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
        assert.strictEqual(member.existedBefore, false);
    });
})();
