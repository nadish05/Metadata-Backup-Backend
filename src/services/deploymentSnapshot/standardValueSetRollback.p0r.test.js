'use strict';

const assert = require('assert');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const {
    isCaptureAllowlisted
} = require('./destinationSnapshotMapper.service');
const {
    buildStandardValueSetSoql,
    usesToolingApi
} = require('../destinationInventory/destinationExistenceQueries');
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

const LEAD_SOURCE = 'LeadSource';
const OPPORTUNITY_STAGE = 'OpportunityStage';
const OPPORTUNITY_TYPE = 'OpportunityType';
const LEAD_SOURCE_PATH =
    'force-app/main/default/standardValueSets/LeadSource.standardValueSet-meta.xml';
const STAGE_PATH =
    'force-app/main/default/standardValueSets/OpportunityStage.standardValueSet-meta.xml';
const TYPE_PATH =
    'force-app/main/default/standardValueSets/OpportunityType.standardValueSet-meta.xml';

const LEAD_SOURCE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<StandardValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>LeadSource</fullName>
    <sorted>false</sorted>
    <standardValue>
        <fullName>Web</fullName>
        <default>false</default>
        <label>Web</label>
    </standardValue>
</StandardValueSet>`;

const LEAD_SOURCE_XML_MODIFIED = LEAD_SOURCE_XML.replace(
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

function packSvsXml(xml, relativePath = LEAD_SOURCE_PATH) {
    return packMemberFiles([
        {
            relativePath,
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
            throw new Error('Simulated StandardValueSet query failure');
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
    await runTest('TEST 1 — StandardValueSet is in snapshot allowlist', () => {
        assert.strictEqual(isCaptureAllowlisted('StandardValueSet'), true);
    });

    await runTest('TEST 2 — LeadSource destination EXISTS is detected', async () => {
        const stub = stubToolingQuery({ totalSize: 1, records: [{ Id: '0' }] });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'StandardValueSet',
                        metadataName: LEAD_SOURCE
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get(`StandardValueSet:${LEAD_SOURCE}`).state,
                DESTINATION_STATE.EXISTS
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 3 — LeadSource destination MISSING is detected', async () => {
        const stub = stubToolingQuery({ totalSize: 0, records: [] });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'StandardValueSet',
                        metadataName: LEAD_SOURCE
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get(`StandardValueSet:${LEAD_SOURCE}`).state,
                DESTINATION_STATE.MISSING
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 4 — OpportunityStage and OpportunityType EXISTS/MISSING', async () => {
        const stub = stubToolingQuery({ totalSize: 1, records: [{ Id: '0' }] });

        try {
            const exists = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'StandardValueSet',
                        metadataName: OPPORTUNITY_STAGE
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });
            assert.strictEqual(
                exists.inventory.get(`StandardValueSet:${OPPORTUNITY_STAGE}`).state,
                DESTINATION_STATE.EXISTS
            );
        } finally {
            stub.restore();
        }

        const stubMissing = stubToolingQuery({ totalSize: 0, records: [] });
        try {
            const missing = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'StandardValueSet',
                        metadataName: OPPORTUNITY_TYPE
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });
            assert.strictEqual(
                missing.inventory.get(`StandardValueSet:${OPPORTUNITY_TYPE}`)
                    .state,
                DESTINATION_STATE.MISSING
            );
        } finally {
            stubMissing.restore();
        }
    });

    await runTest('TEST 6 — API error returns UNKNOWN', async () => {
        const stub = stubToolingQuery({ fail: true });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'StandardValueSet',
                        metadataName: OPPORTUNITY_STAGE
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get(`StandardValueSet:${OPPORTUNITY_STAGE}`).state,
                DESTINATION_STATE.UNKNOWN
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 4 endpoint — Tooling query with FullName filter', () => {
        assert.strictEqual(usesToolingApi('StandardValueSet'), true);
        const soql = buildStandardValueSetSoql(LEAD_SOURCE);
        assert.ok(soql.includes("FullName = 'LeadSource'"));
        const paths = buildExpectedMemberSourcePaths('StandardValueSet', LEAD_SOURCE);
        assert.strictEqual(paths.logical, LEAD_SOURCE_PATH);
    });

    await runTest('TEST 7 — logical retrieval selects exact StandardValueSet file', () => {
        const files = selectLogicalMemberFiles(
            [
                { relativePath: LEAD_SOURCE_PATH, bytes: Buffer.from('a') },
                { relativePath: STAGE_PATH, bytes: Buffer.from('b') }
            ],
            'StandardValueSet',
            LEAD_SOURCE
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, LEAD_SOURCE_PATH);
    });

    await runTest('TEST 8 — EXISTS + RAW equal → UNCHANGED', () => {
        const bytes = packSvsXml(LEAD_SOURCE_XML);
        const result = classifyExistingMemberChange({
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            destinationBeforeArtifactBytes: bytes,
            expectedAfterArtifactBytes: bytes,
            expectedAfterHash: hashBytes(bytes)
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
    });

    await runTest('TEST 9 — EXISTS + RAW different → MODIFIED', () => {
        const before = packSvsXml(LEAD_SOURCE_XML);
        const after = packSvsXml(LEAD_SOURCE_XML_MODIFIED);
        const result = classifyExistingMemberChange({
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            destinationBeforeArtifactBytes: before,
            expectedAfterArtifactBytes: after,
            expectedAfterHash: hashBytes(after)
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.MODIFIED);
    });

    await runTest('TEST 10 — MISSING → NEW capture shape', async () => {
        const afterBytes = packSvsXml(LEAD_SOURCE_XML);
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
                    metadataType: 'StandardValueSet',
                    metadataName: LEAD_SOURCE,
                    filePath: LEAD_SOURCE_PATH,
                    changeClass: CHANGE_CLASS.NEW,
                    expectedAfterHash: hashBytes(afterBytes)
                }
            ]
        });
        const member = (await capture.getMembers(ready.snapshotId))[0];

        assert.strictEqual(member.changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
        assert.strictEqual(member.artifactId, null);
    });

    await runTest('TEST 11 — missing expected-after artifact → UNKNOWN', () => {
        const before = packSvsXml(LEAD_SOURCE_XML);
        const result = classifyExistingMemberChange({
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            destinationBeforeArtifactBytes: before,
            expectedAfterArtifactBytes: Buffer.alloc(0),
            expectedAfterHash: hashBytes(before)
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNKNOWN);
    });

    await runTest('TEST 12 — missing before artifact → UNKNOWN', () => {
        const after = packSvsXml(LEAD_SOURCE_XML);
        const result = classifyExistingMemberChange({
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            destinationBeforeArtifactBytes: Buffer.alloc(0),
            expectedAfterArtifactBytes: after,
            expectedAfterHash: hashBytes(after)
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNKNOWN);
    });

    await runTest('TEST 13 — NEW delete rollback destructive manifest', async () => {
        const afterBytes = packSvsXml(LEAD_SOURCE_XML);
        const member = {
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(afterBytes)
        };

        assert.strictEqual(isDeleteRollbackEligibleMember(member), true);
        const xml = generateDestructiveChangesXml({
            metadata: [
                {
                    metadataType: 'StandardValueSet',
                    metadataName: LEAD_SOURCE
                }
            ]
        });
        assert.match(xml, /<name>StandardValueSet<\/name>/);
        assert.match(xml, /<members>LeadSource<\/members>/);

        const workspace = await buildDeleteRollbackWorkspace({ members: [member] });
        assert.match(
            workspace.generatedManifest.destructiveChangesXml,
            /LeadSource/
        );
        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 14 — MODIFIED restore workspace contains StandardValueSet file', async () => {
        const beforeBytes = packSvsXml(LEAD_SOURCE_XML);
        const afterBytes = packSvsXml(LEAD_SOURCE_XML_MODIFIED);
        const member = {
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-svs-modified',
            artifactBytes: beforeBytes
        };

        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: 'snapshot_svs_restore' },
            members: [member],
            getArtifact: async () => beforeBytes
        });

        const restoredPath = path.join(workspace.workspacePath, LEAD_SOURCE_PATH);
        assert.ok(fs.existsSync(restoredPath));
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /<members>LeadSource<\/members>/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 15 — drift blocks delete rollback when hash differs', () => {
        const expectedHash = hashBytes(packSvsXml(LEAD_SOURCE_XML));
        const drift = compareNewMemberForDeleteRollback({
            expectedAfterHash: expectedHash,
            currentDestinationHash: 'other-hash'
        });

        assert.strictEqual(drift.classification, DRIFT_CLASSIFICATION.DRIFTED);
    });

    await runTest('TEST 16 — auto-included StandardValueSet is rollback-eligible when captured', () => {
        const member = {
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: hashBytes(packSvsXml(LEAD_SOURCE_XML))
        };

        assert.strictEqual(isDeleteRollbackEligibleMember(member), true);
    });

    await runTest('TEST 17 — unchanged StandardValueSet is not a rollback member', () => {
        const result = classifyExistingMemberChange({
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            destinationBeforeArtifactBytes: packSvsXml(LEAD_SOURCE_XML),
            expectedAfterArtifactBytes: packSvsXml(LEAD_SOURCE_XML),
            expectedAfterHash: hashBytes(packSvsXml(LEAD_SOURCE_XML))
        });

        assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
    });

    await runTest('TEST 18 — mixed rollback with StandardValueSet MODIFIED + ValidationRule NEW', () => {
        const svsMember = {
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'a',
            expectedAfterHash: 'b',
            artifactId: 'artifact-svs'
        };
        const ruleMember = {
            metadataType: 'ValidationRule',
            metadataName: 'Opportunity.Amount_must_be_greater_than_0',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'c'
        };

        assert.strictEqual(
            resolveRollbackMode([svsMember, ruleMember]),
            ROLLBACK_MODE.MIXED
        );
        assert.strictEqual(isModifiedRollbackEligibleMember(svsMember), true);
    });

    await runTest('MODIFIED drift — MATCHES_EXPECTED_AFTER', () => {
        const after = packSvsXml(LEAD_SOURCE_XML_MODIFIED);
        const result = compareMemberExpectedAfterDrift({
            metadataType: 'StandardValueSet',
            metadataName: LEAD_SOURCE,
            filePath: LEAD_SOURCE_PATH,
            destinationBeforeHash: hashBytes(packSvsXml(LEAD_SOURCE_XML)),
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
