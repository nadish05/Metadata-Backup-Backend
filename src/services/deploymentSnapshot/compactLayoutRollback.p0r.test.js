'use strict';

const assert = require('assert');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    isCaptureAllowlisted
} = require('./destinationSnapshotMapper.service');
const {
    buildExpectedMemberSourcePaths,
    selectLogicalMemberFiles
} = require('./destinationMetadataRetriever.service');
const {
    classifyExistingMemberChange,
    EXISTING_MEMBER_CHANGE
} = require('./effectiveMemberChange.service');
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

const METADATA_TYPE = 'CompactLayout';
const METADATA_NAME = 'Opportunity.Opportunity_Highlights';
const FILE_PATH =
    'force-app/main/default/objects/Opportunity/compactLayouts/Opportunity_Highlights.compactLayout-meta.xml';

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CompactLayout xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Opportunity_Highlights</fullName>
    <fields>Name</fields>
    <fields>Amount</fields>
    <label>Opportunity Highlights</label>
</CompactLayout>`;

const LAYOUT_XML_MODIFIED = LAYOUT_XML.replace(
    '<fields>Amount</fields>',
    '<fields>StageName</fields>'
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

function packLayoutXml(xml) {
    return packMemberFiles([
        {
            relativePath: FILE_PATH,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

const API_VERSIONS = [{ version: '64.0' }];

function stubToolingQuery({ totalSize, records = [], fail = false }) {
    const originalGet = axios.get;

    axios.get = async (url) => {
        if (url.endsWith('/services/data/')) {
            return { status: 200, data: API_VERSIONS };
        }

        if (fail) {
            throw new Error('Simulated CompactLayout query failure');
        }

        return {
            status: 200,
            data: { totalSize, done: true, records }
        };
    };

    return {
        restore() {
            axios.get = originalGet;
        }
    };
}

(async () => {
    await runTest('TEST 1 — CompactLayout destination EXISTS is detected', async () => {
        const stub = stubToolingQuery({ totalSize: 1, records: [{ Id: '0' }] });

        try {
            const result = await buildDestinationInventory({
                items: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get(`${METADATA_TYPE}:${METADATA_NAME}`).state,
                DESTINATION_STATE.EXISTS
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 2 — CompactLayout destination MISSING is detected', async () => {
        const stub = stubToolingQuery({ totalSize: 0, records: [] });

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

    await runTest('TEST 3 — CompactLayout query failure → UNKNOWN', async () => {
        const stub = stubToolingQuery({ fail: true });

        try {
            const result = await buildDestinationInventory({
                items: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get(`${METADATA_TYPE}:${METADATA_NAME}`).state,
                DESTINATION_STATE.UNKNOWN
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 4 — CompactLayout is in snapshot allowlist', () => {
        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
    });

    await runTest('TEST 5 — exact CompactLayout file path is resolved', () => {
        const paths = buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME);

        assert.strictEqual(paths.logical, FILE_PATH);
    });

    await runTest('TEST 6 — RAW expected-after artifact without explicit filePath', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'compact-layout-expected-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, LAYOUT_XML, 'utf8');

        try {
            const result = await collectExpectedAfterArtifact({
                workspacePath,
                member: {
                    metadataType: METADATA_TYPE,
                    metadataName: METADATA_NAME,
                    filePath: null
                }
            });

            assert.ok(result.expectedAfterHash);
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

    await runTest('TEST 7 — expectedAfterHash matches packed layout artifact', async () => {
        const bytes = packLayoutXml(LAYOUT_XML);

        assert.strictEqual(hashBytes(bytes), hashBytes(packLayoutXml(LAYOUT_XML)));
    });

    await runTest('TEST 8 — filePath convention matches logical retrieve path', () => {
        assert.strictEqual(
            buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME).logical,
            FILE_PATH
        );
    });

    await runTest('TEST 9 — MODIFIED CompactLayout passes rollback eligibility', () => {
        const beforeBytes = packLayoutXml(LAYOUT_XML);
        const afterBytes = packLayoutXml(LAYOUT_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-cl-modified'
        };

        assert.strictEqual(isModifiedRollbackEligibleMember(member), true);
    });

    await runTest('TEST 10 — MODIFIED restore uses previous artifact bytes', async () => {
        const beforeBytes = packLayoutXml(LAYOUT_XML);
        const afterBytes = packLayoutXml(LAYOUT_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-cl-modified',
            artifactBytes: beforeBytes
        };

        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: 'snapshot_cl_restore' },
            members: [member],
            getArtifact: async () => beforeBytes
        });

        const restoredPath = path.join(workspace.workspacePath, FILE_PATH);
        assert.ok(fs.existsSync(restoredPath));
        assert.match(fs.readFileSync(restoredPath, 'utf8'), /Opportunity_Highlights/);
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /<name>CompactLayout<\/name>/
        );
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /Opportunity\.Opportunity_Highlights/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 11 — CompactLayout is not manual rollback', () => {
        const afterBytes = packLayoutXml(LAYOUT_XML);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(afterBytes)
        };

        const partition = partitionRollbackExecutionMembers([member]);

        assert.strictEqual(partition.automaticMembers.length, 1);
        assert.strictEqual(partition.manualRollbackItems.length, 0);
    });

    await runTest('TEST 12 — NEW CompactLayout delete rollback eligibility', () => {
        const afterBytes = packLayoutXml(LAYOUT_XML);
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

    await runTest('TEST 13 — destructive rollback manifest contains CompactLayout', async () => {
        const afterBytes = packLayoutXml(LAYOUT_XML);
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
        assert.match(xml, /<name>CompactLayout<\/name>/);
        assert.match(xml, /<members>Opportunity\.Opportunity_Highlights<\/members>/);

        const workspace = await buildDeleteRollbackWorkspace({ members: [member] });
        assert.match(
            workspace.generatedManifest.destructiveChangesXml,
            /Opportunity\.Opportunity_Highlights/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 14 — CompactLayout stays automatic in mixed manual partition', () => {
        const recordTypeMember = {
            metadataType: 'RecordType',
            metadataName: 'Opportunity.New_Business',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'rt-hash'
        };
        const layoutMember = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(packLayoutXml(LAYOUT_XML))
        };

        const partition = partitionRollbackExecutionMembers([
            recordTypeMember,
            layoutMember
        ]);

        assert.strictEqual(partition.manualRollbackItems.length, 1);
        assert.strictEqual(partition.manualRollbackItems[0].metadataType, 'RecordType');
        assert.strictEqual(partition.automaticMembers.length, 1);
        assert.strictEqual(partition.automaticMembers[0].metadataType, METADATA_TYPE);
    });

    await runTest('TEST 15 — post-delete verification expects MISSING inventory state', async () => {
        const stub = stubToolingQuery({ totalSize: 0, records: [] });

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

    await runTest('TEST 16 — MODIFIED drift MATCH allows rollback comparison', () => {
        const before = packLayoutXml(LAYOUT_XML);
        const after = packLayoutXml(LAYOUT_XML_MODIFIED);
        const result = compareMemberExpectedAfterDrift({
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            destinationBeforeHash: hashBytes(before),
            expectedAfterHash: hashBytes(after),
            expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW,
            currentDestinationHash: hashBytes(after),
            currentDestinationArtifactBytes: after
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest('TEST 17 — MODIFIED drift DRIFT blocks comparison', () => {
        const before = packLayoutXml(LAYOUT_XML);
        const after = packLayoutXml(LAYOUT_XML_MODIFIED);
        const thirdXml = LAYOUT_XML.replace(
            '<fields>Name</fields>',
            '<fields>CloseDate</fields>'
        );
        const third = packLayoutXml(thirdXml);
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

    await runTest('TEST 18 — NEW delete drift MATCH allows delete rollback', () => {
        const expectedHash = hashBytes(packLayoutXml(LAYOUT_XML));
        const result = compareNewMemberForDeleteRollback({
            expectedAfterHash: expectedHash,
            currentDestinationHash: expectedHash
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest('TEST 19 — NEW delete drift DRIFT blocks delete rollback', () => {
        const expectedHash = hashBytes(packLayoutXml(LAYOUT_XML));
        const result = compareNewMemberForDeleteRollback({
            expectedAfterHash: expectedHash,
            currentDestinationHash: 'other-hash'
        });

        assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
    });

    await runTest('TEST 20 — UNKNOWN existence remains fail-closed', async () => {
        const stub = stubToolingQuery({ fail: true });

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

    await runTest('logical retrieve selects only CompactLayout file', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(LAYOUT_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/objects/Opportunity/fields/Amount.field-meta.xml',
                    bytes: Buffer.from('field')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('NEW capture shape uses ABSENT_PROVEN', async () => {
        const afterBytes = packLayoutXml(LAYOUT_XML);
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

    await runTest('mixed rollback MODIFIED CompactLayout + NEW ValidationRule', () => {
        const layoutMember = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'cl-before',
            expectedAfterHash: 'cl-after',
            artifactId: 'artifact-cl'
        };
        const ruleMember = {
            metadataType: 'ValidationRule',
            metadataName: 'Opportunity.Require_Stage',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'vr-after'
        };

        assert.strictEqual(
            resolveRollbackMode([layoutMember, ruleMember]),
            ROLLBACK_MODE.MIXED
        );
    });
})();
