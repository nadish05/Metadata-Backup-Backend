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
    ROLLBACK_MODE,
    computeRollbackEligible
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
const { buildLayoutSoql } = require('../destinationInventory/destinationExistenceQueries');

const METADATA_TYPE = 'Layout';
const METADATA_NAME = 'Account-Gym Member Layout';
const METADATA_NAME_SPACES = 'Account-Account Layout';
const FILE_PATH =
    'force-app/main/default/layouts/Account-Gym Member Layout.layout-meta.xml';

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <customLabel>false</customLabel>
        <detailHeading>false</detailHeading>
        <editHeading>true</editHeading>
        <label>Information</label>
        <layoutColumns>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>Name</field>
            </layoutItems>
        </layoutColumns>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
</Layout>`;

const LAYOUT_XML_MODIFIED = LAYOUT_XML.replace(
    '<field>Name</field>',
    '<field>AccountNumber</field>'
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

function packLayoutXml(xml, relativePath = FILE_PATH) {
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
            throw new Error('Simulated Layout query failure');
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
    await runTest('TEST 1 — Layout destination EXISTS is detected', async () => {
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

    await runTest('TEST 2 — Layout destination MISSING is detected', async () => {
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

    await runTest('TEST 3 — Layout query failure → UNKNOWN', async () => {
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

    await runTest('TEST 4 — malformed Layout member name fails closed as UNKNOWN', async () => {
        const stub = stubToolingQuery({ totalSize: 0, records: [] });

        try {
            const result = await buildDestinationInventory({
                items: [
                    { metadataType: METADATA_TYPE, metadataName: 'NoHyphenLayout' }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            const entry = result.inventory.get(`${METADATA_TYPE}:NoHyphenLayout`);
            assert.strictEqual(entry.state, DESTINATION_STATE.UNKNOWN);
            assert.strictEqual(entry.unsupported, true);
            assert.notStrictEqual(entry.state, DESTINATION_STATE.MISSING);
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 5 — Layout is capture-allowlisted', () => {
        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
    });

    await runTest('TEST 6 — member names with spaces and hyphens preserve logical path', () => {
        const paths = buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME);
        assert.strictEqual(paths.logical, FILE_PATH);

        const spaced = buildExpectedMemberSourcePaths(
            METADATA_TYPE,
            METADATA_NAME_SPACES
        );
        assert.strictEqual(
            spaced.logical,
            'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml'
        );
    });

    await runTest('TEST 7 — buildLayoutSoql targets Tooling Layout FullName', () => {
        const soql = buildLayoutSoql(METADATA_NAME);

        assert.ok(soql.includes('FROM Layout'));
        assert.ok(soql.includes("FullName = 'Account-Gym Member Layout'"));
        assert.ok(soql.includes('LIMIT 1'));
        assert.strictEqual(buildLayoutSoql('InvalidMember'), null);
    });

    await runTest('TEST 8 — RAW expected-after artifact without explicit filePath', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'page-layout-expected-')
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

    await runTest('TEST 9 — MODIFIED Layout passes rollback eligibility', () => {
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
            artifactId: 'artifact-layout-modified'
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
            artifactId: 'artifact-layout-modified',
            artifactBytes: beforeBytes
        };

        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: 'snapshot_layout_restore' },
            members: [member],
            getArtifact: async () => beforeBytes
        });

        const restoredPath = path.join(workspace.workspacePath, FILE_PATH);
        assert.ok(fs.existsSync(restoredPath));
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /<name>Layout<\/name>/
        );
        assert.match(
            fs.readFileSync(workspace.packageXmlPath, 'utf8'),
            /Account-Gym Member Layout/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 11 — NEW Layout delete rollback eligibility', () => {
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

    await runTest('TEST 12 — destructive rollback manifest contains exact Layout member', async () => {
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
        assert.match(xml, /<name>Layout<\/name>/);
        assert.match(xml, /<members>Account-Gym Member Layout<\/members>/);

        const workspace = await buildDeleteRollbackWorkspace({ members: [member] });
        assert.match(
            workspace.generatedManifest.destructiveChangesXml,
            /Account-Gym Member Layout/
        );

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('TEST 13 — UNKNOWN capture status is not rollback-eligible', () => {
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.UNKNOWN,
            captureStatus: MEMBER_CAPTURE_STATUS.UNKNOWN,
            expectedAfterHash: 'hash'
        };

        assert.strictEqual(isDeleteRollbackEligibleMember(member), false);
        assert.strictEqual(isModifiedRollbackEligibleMember(member), false);
        assert.strictEqual(computeRollbackEligible([member]), false);
    });

    await runTest('TEST 14 — logical retrieve selects only Layout file', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(LAYOUT_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/layouts/Contact-Contact Layout.layout-meta.xml',
                    bytes: Buffer.from('<Layout/>')
                },
                {
                    relativePath:
                        'force-app/main/default/objects/Account/Account.object-meta.xml',
                    bytes: Buffer.from('object')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('TEST 15 — missing logical Layout file fails closed', () => {
        assert.throws(
            () =>
                selectLogicalMemberFiles(
                    [
                        {
                            relativePath:
                                'force-app/main/default/layouts/Contact-Contact Layout.layout-meta.xml',
                            bytes: Buffer.from('<Layout/>')
                        }
                    ],
                    METADATA_TYPE,
                    METADATA_NAME
                ),
            /did not return the logical file/
        );
    });

    await runTest('TEST 16 — NEW capture shape uses ABSENT_PROVEN', async () => {
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

    await runTest('TEST 17 — mixed rollback MODIFIED Layout + NEW ValidationRule', () => {
        const layoutMember = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'layout-before',
            expectedAfterHash: 'layout-after',
            artifactId: 'artifact-layout'
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
            resolveRollbackMode([layoutMember, ruleMember]),
            ROLLBACK_MODE.MIXED
        );
    });

    await runTest('TEST 18 — CompactLayout and Flow allowlist unchanged', () => {
        assert.strictEqual(isCaptureAllowlisted('CompactLayout'), true);
        assert.strictEqual(isCaptureAllowlisted('Flow'), true);
        assert.strictEqual(
            buildExpectedMemberSourcePaths(
                'CompactLayout',
                'Opportunity.Opportunity_Highlights'
            ).logical,
            'force-app/main/default/objects/Opportunity/compactLayouts/Opportunity_Highlights.compactLayout-meta.xml'
        );
    });
})();
