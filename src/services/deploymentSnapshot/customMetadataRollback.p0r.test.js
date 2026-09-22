'use strict';

const assert = require('assert');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildCustomMetadataEntityDefinitionSoql,
    buildCustomMetadataSoql,
    parseCustomMetadataMember,
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
    compareMemberExpectedAfterDrift,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');
const {
    isDeleteRollbackEligibleMember,
    isModifiedRollbackEligibleMember
} = require('./snapshotRollbackEligibility.service');
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
const { mapExistenceToChangeClass } = require('./destinationSnapshotMapper.service');

const METADATA_TYPE = 'CustomMetadata';
const METADATA_NAME = 'Weather_Config.Default';
const FILE_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Default.md-meta.xml';

const CMDT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Default Fixture</label>
    <protected>false</protected>
</CustomMetadata>`;

const CMDT_XML_MODIFIED = CMDT_XML.replace('Default Fixture', 'Default Fixture Updated');

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

function packCustomMetadataXml(xml) {
    return packMemberFiles([
        {
            relativePath: FILE_PATH,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

const API_VERSIONS = [{ version: '64.0' }];

function stubCustomMetadataInventory({
    entityTotalSize,
    recordTotalSize,
    failOnEntity = false,
    failOnRecord = false
}) {
    const originalGet = axios.get;
    const requestedUrls = [];

    axios.get = async (url) => {
        if (url.endsWith('/services/data/')) {
            return { status: 200, data: API_VERSIONS };
        }

        requestedUrls.push(url);

        if (failOnEntity && decodeURIComponent(url).includes('EntityDefinition')) {
            throw new Error('Simulated EntityDefinition query failure');
        }

        if (failOnRecord && decodeURIComponent(url).includes('Weather_Config__mdt')) {
            throw new Error('Simulated CustomMetadata record query failure');
        }

        if (decodeURIComponent(url).includes('EntityDefinition')) {
            return {
                status: 200,
                data: {
                    totalSize: entityTotalSize,
                    done: true,
                    records:
                        entityTotalSize > 0
                            ? [{ QualifiedApiName: 'Weather_Config__mdt' }]
                            : []
                }
            };
        }

        if (decodeURIComponent(url).includes('Weather_Config__mdt')) {
            return {
                status: 200,
                data: {
                    totalSize: recordTotalSize,
                    done: true,
                    records: recordTotalSize > 0 ? [{ Id: '0' }] : []
                }
            };
        }

        throw new Error(`Unexpected inventory query: ${url}`);
    };

    return {
        requestedUrls,
        restore() {
            axios.get = originalGet;
        }
    };
}

(async () => {
    await runTest('TEST 1 — NEW with absent CMDT type is MISSING not UNKNOWN', async () => {
        const stub = stubCustomMetadataInventory({ entityTotalSize: 0, recordTotalSize: 0 });

        try {
            const result = await buildDestinationInventory({
                items: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            const entry = result.inventory.get(`${METADATA_TYPE}:${METADATA_NAME}`);
            assert.strictEqual(entry.state, DESTINATION_STATE.MISSING);
            assert.notStrictEqual(entry.state, DESTINATION_STATE.UNKNOWN);
            assert.strictEqual(mapExistenceToChangeClass(entry.state), CHANGE_CLASS.NEW);
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 2 — NEW with type present record absent is MISSING', async () => {
        const stub = stubCustomMetadataInventory({ entityTotalSize: 1, recordTotalSize: 0 });

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

    await runTest('TEST 3 — MODIFIED when type and record exist is EXISTS', async () => {
        const stub = stubCustomMetadataInventory({ entityTotalSize: 1, recordTotalSize: 1 });

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
            assert.strictEqual(
                mapExistenceToChangeClass(DESTINATION_STATE.EXISTS),
                CHANGE_CLASS.MODIFIED
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 4 — EntityDefinition query failure remains UNKNOWN', async () => {
        const stub = stubCustomMetadataInventory({
            entityTotalSize: 0,
            recordTotalSize: 0,
            failOnEntity: true
        });

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

    await runTest('TEST 5 — record query failure remains UNKNOWN', async () => {
        const stub = stubCustomMetadataInventory({
            entityTotalSize: 1,
            recordTotalSize: 0,
            failOnRecord: true
        });

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

    await runTest('TEST 6 — exact logical retrieval path', () => {
        assert.strictEqual(
            buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME).logical,
            FILE_PATH
        );
    });

    await runTest('TEST 7 — logical selector excludes unrelated workspace files', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(CMDT_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/customMetadata/Weather_Config.Production.md-meta.xml',
                    bytes: Buffer.from('<CustomMetadata/>')
                },
                {
                    relativePath:
                        'force-app/main/default/objects/Weather_Config__mdt/Weather_Config__mdt.object-meta.xml',
                    bytes: Buffer.from('<CustomObject/>')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('TEST 8 — expected-after path fallback when filePath is null', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'custom-metadata-expected-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, CMDT_XML, 'utf8');

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

    await runTest('TEST 9 — RAW representation and snapshot allowlist', async () => {
        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
        assert.strictEqual(usesToolingApi('CustomMetadata'), false);

        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'custom-metadata-raw-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, CMDT_XML, 'utf8');

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

    await runTest('EntityDefinition SOQL is REST and targets Weather_Config__mdt', () => {
        const soql = buildCustomMetadataEntityDefinitionSoql(METADATA_NAME);

        assert.ok(soql.includes('FROM EntityDefinition'));
        assert.ok(soql.includes("QualifiedApiName = 'Weather_Config__mdt'"));
    });

    await runTest('record SOQL uses parsed identity', () => {
        const parsed = parseCustomMetadataMember(METADATA_NAME);

        assert.strictEqual(parsed.typeDeveloperName, 'Weather_Config');
        assert.strictEqual(parsed.recordDeveloperName, 'Default');
        assert.ok(buildCustomMetadataSoql(METADATA_NAME).includes('FROM Weather_Config__mdt'));
    });

    await runTest('MODIFIED restore uses destination-before artifact bytes', async () => {
        const beforeBytes = packCustomMetadataXml(CMDT_XML);
        const afterBytes = packCustomMetadataXml(CMDT_XML_MODIFIED);
        const member = {
            metadataType: METADATA_TYPE,
            metadataName: METADATA_NAME,
            filePath: FILE_PATH,
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: hashBytes(beforeBytes),
            expectedAfterHash: hashBytes(afterBytes),
            artifactId: 'artifact-cmdt-modified',
            artifactBytes: beforeBytes
        };

        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: 'snapshot_cmdt_restore' },
            members: [member],
            getArtifact: async () => beforeBytes
        });

        const restoredPath = path.join(workspace.workspacePath, FILE_PATH);
        assert.ok(fs.existsSync(restoredPath));
        assert.match(fs.readFileSync(restoredPath, 'utf8'), /Default Fixture/);

        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('MODIFIED drift mismatch blocks rollback comparison', () => {
        const before = packCustomMetadataXml(CMDT_XML);
        const after = packCustomMetadataXml(CMDT_XML_MODIFIED);
        const third = packCustomMetadataXml(
            CMDT_XML.replace('Default Fixture', 'Third State')
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

    await runTest('NEW delete and MODIFIED rollback eligibility', () => {
        const afterBytes = packCustomMetadataXml(CMDT_XML);

        assert.strictEqual(
            isDeleteRollbackEligibleMember({
                metadataType: METADATA_TYPE,
                metadataName: METADATA_NAME,
                filePath: FILE_PATH,
                changeClass: CHANGE_CLASS.NEW,
                captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
                existedBefore: false,
                expectedAfterHash: hashBytes(afterBytes)
            }),
            true
        );

        assert.strictEqual(
            isModifiedRollbackEligibleMember({
                metadataType: METADATA_TYPE,
                metadataName: METADATA_NAME,
                filePath: FILE_PATH,
                changeClass: CHANGE_CLASS.MODIFIED,
                captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
                destinationBeforeHash: hashBytes(afterBytes),
                expectedAfterHash: hashBytes(packCustomMetadataXml(CMDT_XML_MODIFIED)),
                artifactId: 'artifact-cmdt'
            }),
            true
        );
    });

    await runTest('NEW capture shape uses ABSENT_PROVEN', async () => {
        const afterBytes = packCustomMetadataXml(CMDT_XML);
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

        assert.strictEqual(members[0].captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
        assert.strictEqual(members[0].existedBefore, false);
    });
})();
