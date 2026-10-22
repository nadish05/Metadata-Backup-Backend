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
    isCaptureAllowlisted,
    mapExistenceToChangeClass
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
    isModifiedRollbackEligibleMember,
    computeRollbackEligible,
    resolveRollbackMode,
    ROLLBACK_MODE
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
const METADATA_TYPE = 'PermissionSet';
const METADATA_NAME = 'Subscription_Access';
const FILE_PATH =
    'force-app/main/default/permissionsets/Subscription_Access.permissionset-meta.xml';
const OTHER_PS_PATH =
    'force-app/main/default/permissionsets/Other_Access.permissionset-meta.xml';

const PS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <hasActivationRequired>false</hasActivationRequired>
    <label>Subscription Access</label>
    <license>Salesforce</license>
</PermissionSet>`;

const PS_XML_MODIFIED = PS_XML.replace(
    'Subscription Access',
    'Subscription Access Updated'
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

function packPermissionSetXml(xml) {
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
            throw new Error('Simulated PermissionSet query failure');
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
    await runTest('TEST 1 — PermissionSet is capture-allowlisted', () => {
        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
    });

    await runTest('TEST 2 — buildExistenceQuery uses REST PermissionSet Name filter', () => {
        assert.strictEqual(usesToolingApi(METADATA_TYPE), false);
        const soql = buildExistenceQuery(METADATA_TYPE, METADATA_NAME);

        assert.ok(soql.includes("Name = 'Subscription_Access'"));
        assert.ok(soql.includes('IsOwnedByProfile = false'));
    });

    await runTest('TEST 3 — exact PermissionSet DX path is resolved', () => {
        const paths = buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME);

        assert.strictEqual(paths.logical, FILE_PATH);
    });

    await runTest('TEST 4 — logical retrieve selects only the target PermissionSet file', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(PS_XML)
                },
                {
                    relativePath: OTHER_PS_PATH,
                    bytes: Buffer.from('<PermissionSet/>')
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

    await runTest('TEST 5 — missing logical PermissionSet file fails closed', () => {
        assert.throws(
            () =>
                selectLogicalMemberFiles(
                    [
                        {
                            relativePath: OTHER_PS_PATH,
                            bytes: Buffer.from('<PermissionSet/>')
                        }
                    ],
                    METADATA_TYPE,
                    METADATA_NAME
                ),
            /did not return the logical file/
        );
    });

    await runTest('TEST 6 — ambiguous retrieve without target PermissionSet fails closed', () => {
        assert.throws(
            () =>
                selectLogicalMemberFiles(
                    [
                        {
                            relativePath: OTHER_PS_PATH,
                            bytes: Buffer.from('<PermissionSet/>')
                        },
                        {
                            relativePath:
                                'force-app/main/default/namedCredentials/Backup_API.namedCredential-meta.xml',
                            bytes: Buffer.from('<NamedCredential/>')
                        }
                    ],
                    METADATA_TYPE,
                    METADATA_NAME
                ),
            /did not return the logical file/
        );
    });

    await runTest('TEST 7 — expected-after path resolves without explicit filePath', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'permission-set-expected-after-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, PS_XML, 'utf8');

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
            assert.strictEqual(
                result.expectedAfterRepresentation,
                EXPECTED_AFTER_REPRESENTATION.RAW
            );
        } finally {
            await fs.promises.rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('TEST 8 — unrelated retrieved files do not affect PermissionSet hash', () => {
        const retrieved = [
            {
                relativePath: FILE_PATH,
                bytes: Buffer.from(PS_XML)
            },
            {
                relativePath: OTHER_PS_PATH,
                bytes: Buffer.from('<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"/>')
            }
        ];
        const selected = selectLogicalMemberFiles(
            retrieved,
            METADATA_TYPE,
            METADATA_NAME
        );
        const selectedHash = hashBytes(packMemberFiles(selected));
        const allFilesHash = hashBytes(packMemberFiles(retrieved));

        assert.notStrictEqual(selectedHash, allFilesHash);
        assert.strictEqual(selectedHash, hashBytes(packPermissionSetXml(PS_XML)));
    });

    await runTest('TEST 9 — NEW PermissionSet with ABSENT_PROVEN is DELETE-eligible', () => {
        const afterBytes = packPermissionSetXml(PS_XML);
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

    await runTest('TEST 10 — UNKNOWN existence cannot establish NEW rollback eligibility', () => {
        assert.strictEqual(
            mapExistenceToChangeClass(DESTINATION_STATE.UNKNOWN),
            CHANGE_CLASS.UNKNOWN
        );

        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.UNKNOWN,
            captureStatus: MEMBER_CAPTURE_STATUS.UNKNOWN,
            expectedAfterHash: hashBytes(packPermissionSetXml(PS_XML))
        };

        assert.strictEqual(isDeleteRollbackEligibleMember(member), false);
        assert.strictEqual(computeRollbackEligible([member]), false);
    });

    await runTest('TEST 11 — MODIFIED PermissionSet passes restore eligibility', () => {
        const beforeBytes = packPermissionSetXml(PS_XML);
        const afterBytes = packPermissionSetXml(PS_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-ps-modified'
        };

        assert.strictEqual(isModifiedRollbackEligibleMember(member), true);
    });

    await runTest('TEST 12 — mixed rollback MODIFIED PermissionSet + NEW ValidationRule', () => {
        const psMember = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'ps-before',
            expectedAfterHash: 'ps-after',
            artifactId: 'artifact-ps'
        };
        const ruleMember = {
            metadataType: 'ValidationRule',
            metadataName: 'Account.Require_Name',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'vr-after'
        };

        assert.strictEqual(
            resolveRollbackMode([psMember, ruleMember]),
            ROLLBACK_MODE.MIXED
        );
    });

    await runTest('TEST 13 — PermissionSet stays automatic in mixed manual partition', () => {
        const recordTypeMember = {
            metadataType: 'RecordType',
            metadataName: 'Opportunity.New_Business',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'rt-hash'
        };
        const psMember = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(packPermissionSetXml(PS_XML))
        };

        const partition = partitionRollbackExecutionMembers([
            recordTypeMember,
            psMember
        ]);

        assert.strictEqual(partition.manualRollbackItems.length, 1);
        assert.strictEqual(partition.manualRollbackItems[0].metadataType, 'RecordType');
        assert.strictEqual(partition.automaticMembers.length, 1);
        assert.strictEqual(partition.automaticMembers[0].metadataType, METADATA_TYPE);
    });

    await runTest('TEST 14 — MODIFIED drift DRIFT blocks rollback comparison', () => {
        const before = packPermissionSetXml(PS_XML);
        const after = packPermissionSetXml(PS_XML_MODIFIED);
        const third = packPermissionSetXml(
            PS_XML.replace('Salesforce', 'SalesforcePlatform')
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

    await runTest('TEST 15 — sealed snapshot rollback eligibility gates remain enforced', async () => {
        const afterBytes = packPermissionSetXml(PS_XML);
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
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        const sealedMembers = await capture.getMembers(ready.snapshotId);

        assert.strictEqual(sealed.rollbackEligible, true);
        assert.strictEqual(computeRollbackEligible(sealedMembers), true);

        const incomplete = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.UNKNOWN,
            expectedAfterHash: hashBytes(afterBytes)
        };
        assert.strictEqual(computeRollbackEligible([incomplete]), false);
    });

    await runTest('TEST 16 — destructive manifest contains PermissionSet member only', async () => {
        const afterBytes = packPermissionSetXml(PS_XML);
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
        assert.match(xml, /<name>PermissionSet<\/name>/);
        assert.match(xml, /<members>Subscription_Access<\/members>/);
        assert.doesNotMatch(xml, /<name>NamedCredential<\/name>/);

        const workspace = await buildDeleteRollbackWorkspace({ members: [member] });
        assert.match(
            workspace.generatedManifest.destructiveChangesXml,
            /Subscription_Access/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 17 — post-delete verification expects MISSING inventory state', async () => {
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

    await runTest('TEST 18 — MODIFIED restore workspace uses destination-before bytes', async () => {
        const beforeBytes = packPermissionSetXml(PS_XML);
        const afterBytes = packPermissionSetXml(PS_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-ps-restore',
            artifactBytes: beforeBytes
        };

        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: 'snapshot_ps_restore' },
            members: [member],
            getArtifact: async () => beforeBytes
        });

        const restoredPath = path.join(workspace.workspacePath, FILE_PATH);
        assert.ok(fs.existsSync(restoredPath));
        assert.match(fs.readFileSync(restoredPath, 'utf8'), /Subscription Access/);
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /<name>PermissionSet<\/name>/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 19 — NEW capture shape uses ABSENT_PROVEN', async () => {
        const afterBytes = packPermissionSetXml(PS_XML);
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

    await runTest('TEST 20 — NamedCredential allowlist and path resolution remain unaffected', () => {
        assert.strictEqual(isCaptureAllowlisted('NamedCredential'), true);
        assert.strictEqual(
            buildExpectedMemberSourcePaths('NamedCredential', 'Backup_API').logical,
            'force-app/main/default/namedCredentials/Backup_API.namedCredential-meta.xml'
        );
    });

    await runTest('NEW delete drift MATCH allows delete rollback', () => {
        const expectedHash = hashBytes(packPermissionSetXml(PS_XML));
        const result = compareNewMemberForDeleteRollback({
            expectedAfterHash: expectedHash,
            currentDestinationHash: expectedHash
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });
})();
