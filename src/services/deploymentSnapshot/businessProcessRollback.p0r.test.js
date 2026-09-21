'use strict';

const assert = require('assert');
const axios = require('axios');
const fs = require('fs');
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
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const { buildDestinationInventory } = require('../destinationInventory/destinationInventoryBuilder.service');

const METADATA_TYPE = 'BusinessProcess';
const METADATA_NAME = 'Opportunity.New Sales Process';
const FILE_PATH =
    'force-app/main/default/objects/Opportunity/businessProcesses/New Sales Process.businessProcess-meta.xml';

const PROCESS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<BusinessProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>New Sales Process</fullName>
    <isActive>true</isActive>
    <values>
        <fullName>Prospecting</fullName>
        <default>false</default>
    </values>
</BusinessProcess>`;

const PROCESS_XML_MODIFIED = PROCESS_XML.replace(
    '<default>false</default>',
    '<default>true</default>'
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

function packProcessXml(xml) {
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
            throw new Error('Simulated BusinessProcess query failure');
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
    await runTest('TEST 1 — BusinessProcess is in snapshot allowlist', () => {
        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
    });

    await runTest('TEST 2 — BusinessProcess destination EXISTS is detected', async () => {
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

    await runTest('TEST 3 — BusinessProcess destination MISSING is detected', async () => {
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

    await runTest('TEST 4 — BusinessProcess logical retrieve resolves exact member', () => {
        const paths = buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME);

        assert.strictEqual(paths.logical, FILE_PATH);

        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(PROCESS_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/objects/Opportunity/businessProcesses/Renewal Process.businessProcess-meta.xml',
                    bytes: Buffer.from('<BusinessProcess/>')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('TEST 5 — EXISTS + RAW equal → UNCHANGED (no snapshot member semantics)', () => {
        const bytes = packProcessXml(PROCESS_XML);
        const result = classifyExistingMemberChange({
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            destinationBeforeArtifactBytes: bytes,
            expectedAfterArtifactBytes: bytes,
            expectedAfterHash: hashBytes(bytes)
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
    });

    await runTest('TEST 6 — EXISTS + RAW different → MODIFIED', () => {
        const before = packProcessXml(PROCESS_XML);
        const after = packProcessXml(PROCESS_XML_MODIFIED);
        const result = classifyExistingMemberChange({
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            destinationBeforeArtifactBytes: before,
            expectedAfterArtifactBytes: after,
            expectedAfterHash: hashBytes(after)
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.MODIFIED);
    });

    await runTest('TEST 7 — MISSING → NEW capture shape (ABSENT_PROVEN)', async () => {
        const afterBytes = packProcessXml(PROCESS_XML);
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
        assert.ok(member.expectedAfterHash);
        assert.strictEqual(member.artifactId, null);
    });

    await runTest('TEST 8 — UNKNOWN inventory state fails closed', async () => {
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

    await runTest('TEST 9 — NEW delete rollback destructive manifest', async () => {
        const afterBytes = packProcessXml(PROCESS_XML);
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

        const xml = generateDestructiveChangesXml({
            metadata: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }]
        });
        assert.match(xml, /<name>BusinessProcess<\/name>/);
        assert.match(xml, /<members>Opportunity\.New Sales Process<\/members>/);

        const workspace = await buildDeleteRollbackWorkspace({ members: [member] });
        assert.match(
            workspace.generatedManifest.destructiveChangesXml,
            /Opportunity\.New Sales Process/
        );
        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 10 — NEW drift blocks delete rollback comparison', () => {
        const expectedHash = hashBytes(packProcessXml(PROCESS_XML));
        const match = compareNewMemberForDeleteRollback({
            expectedAfterHash: expectedHash,
            currentDestinationHash: expectedHash
        });
        const drift = compareNewMemberForDeleteRollback({
            expectedAfterHash: expectedHash,
            currentDestinationHash: 'other-hash'
        });

        assert.strictEqual(
            match.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
        assert.strictEqual(drift.classification, DRIFT_CLASSIFICATION.DRIFTED);
    });

    await runTest('TEST 11 — MODIFIED restore workspace contains BusinessProcess file', async () => {
        const beforeBytes = packProcessXml(PROCESS_XML);
        const afterBytes = packProcessXml(PROCESS_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-bp-modified',
            artifactBytes: beforeBytes
        };

        assert.strictEqual(isModifiedRollbackEligibleMember(member), true);

        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: 'snapshot_bp_restore' },
            members: [member],
            getArtifact: async () => beforeBytes
        });

        const restoredPath = path.join(workspace.workspacePath, FILE_PATH);
        assert.ok(fs.existsSync(restoredPath));
        assert.match(fs.readFileSync(restoredPath, 'utf8'), /New Sales Process/);
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /Opportunity\.New Sales Process/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 12 — mixed rollback RecordType MODIFIED + BusinessProcess NEW', () => {
        const recordTypeMember = {
            metadataType: 'RecordType',
            metadataName: 'Opportunity.Enterprise_Deal',
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'rt-before',
            expectedAfterHash: 'rt-after',
            artifactId: 'artifact-rt'
        };
        const processMember = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            destinationBeforeHash: null,
            artifactId: null,
            expectedAfterHash: hashBytes(packProcessXml(PROCESS_XML))
        };

        assert.strictEqual(
            resolveRollbackMode([recordTypeMember, processMember]),
            ROLLBACK_MODE.MIXED
        );
    });

    await runTest('TEST 13 — auto-included BusinessProcess is rollback-eligible when captured', () => {
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            destinationBeforeHash: null,
            artifactId: null,
            expectedAfterHash: hashBytes(packProcessXml(PROCESS_XML))
        };

        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
        assert.strictEqual(isDeleteRollbackEligibleMember(member), true);
    });

    await runTest('TEST 14 — unchanged BusinessProcess is not rollback member', () => {
        const result = classifyExistingMemberChange({
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            destinationBeforeArtifactBytes: packProcessXml(PROCESS_XML),
            expectedAfterArtifactBytes: packProcessXml(PROCESS_XML),
            expectedAfterHash: hashBytes(packProcessXml(PROCESS_XML))
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
    });

    await runTest('TEST 15 — missing expected-after artifact fails closed', () => {
        const before = packProcessXml(PROCESS_XML);
        const result = classifyExistingMemberChange({
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            destinationBeforeArtifactBytes: before,
            expectedAfterArtifactBytes: Buffer.alloc(0),
            expectedAfterHash: hashBytes(before)
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNKNOWN);
    });

    await runTest('drift protection — MODIFIED uses existing drift semantics', () => {
        const before = packProcessXml(PROCESS_XML);
        const after = packProcessXml(PROCESS_XML_MODIFIED);
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
})();
