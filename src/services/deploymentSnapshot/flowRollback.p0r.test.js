'use strict';

/**
 * Phase 1 — Flow snapshot capture (RAW). No NEW destructive delete rollback in this phase.
 * FlowDefinition existence confirms definition presence, not exact version/active-state match.
 */

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

const METADATA_TYPE = 'Flow';
const METADATA_NAME = 'My_Flow';
const FILE_PATH = 'force-app/main/default/flows/My_Flow.flow-meta.xml';

const FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>64.0</apiVersion>
    <status>Active</status>
</Flow>`;

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

function packFlowXml(xml) {
    return packMemberFiles([
        {
            relativePath: FILE_PATH,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

const API_VERSIONS = [{ version: '64.0' }];

function stubFlowDefinitionInventory({ totalSize, fail = false }) {
    const originalGet = axios.get;
    const requestedUrls = [];

    axios.get = async (url) => {
        if (url.endsWith('/services/data/')) {
            return { status: 200, data: API_VERSIONS };
        }

        requestedUrls.push(url);

        if (fail) {
            throw new Error('Simulated FlowDefinition query failure');
        }

        return {
            status: 200,
            data: {
                totalSize,
                done: true,
                records: totalSize > 0 ? [{ Id: '0' }] : []
            }
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
    await runTest('TEST 1 — Flow NEW + destination MISSING maps to CHANGE_CLASS.NEW', async () => {
        const stub = stubFlowDefinitionInventory({ totalSize: 0 });

        try {
            const result = await buildDestinationInventory({
                items: [{ metadataType: METADATA_TYPE, metadataName: METADATA_NAME }],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            const entry = result.inventory.get(`${METADATA_TYPE}:${METADATA_NAME}`);
            assert.strictEqual(entry.state, DESTINATION_STATE.MISSING);
            assert.strictEqual(mapExistenceToChangeClass(entry.state), CHANGE_CLASS.NEW);
        } finally {
            stub.restore();
        }
    });

    await runTest('TEST 2 — Flow MODIFIED + destination EXISTS maps to CHANGE_CLASS.MODIFIED', async () => {
        const stub = stubFlowDefinitionInventory({ totalSize: 1 });

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

    await runTest('TEST 3 — Flow UNKNOWN when FlowDefinition query fails', async () => {
        const stub = stubFlowDefinitionInventory({ totalSize: 0, fail: true });

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

    await runTest('TEST 4 — Flow uses RAW expected-after representation', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-raw-expected-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, FLOW_XML, 'utf8');

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
        } finally {
            await fs.promises.rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('TEST 5 — Flow logical source path', () => {
        assert.strictEqual(
            buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME).logical,
            FILE_PATH
        );
    });

    await runTest('TEST 6 — Flow logical destination retrieve selection', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(FLOW_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/flows/Other_Flow.flow-meta.xml',
                    bytes: Buffer.from('<Flow/>')
                }
            ],
            METADATA_TYPE,
            METADATA_NAME
        );

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].relativePath, FILE_PATH);
    });

    await runTest('TEST 7 — Flow expected-after filePath fallback', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'flow-expected-fallback-')
        );
        const absolutePath = path.join(workspacePath, FILE_PATH);

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, FLOW_XML, 'utf8');

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

    await runTest('TEST 8 — Flow does not select unrelated flow files', () => {
        const files = selectLogicalMemberFiles(
            [
                {
                    relativePath: FILE_PATH,
                    bytes: Buffer.from(FLOW_XML)
                },
                {
                    relativePath:
                        'force-app/main/default/flows/Invoice_Orchestrator.flow-meta.xml',
                    bytes: Buffer.from('<Flow/>')
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

    await runTest('TEST 9 — Flow identity remains DeveloperName only', () => {
        assert.strictEqual(METADATA_NAME, 'My_Flow');
        assert.ok(!`${METADATA_TYPE}:${METADATA_NAME}`.includes('-1'));
        assert.ok(
            buildExistenceQuery(METADATA_TYPE, METADATA_NAME).includes(
                "DeveloperName = 'My_Flow'"
            )
        );
    });

    await runTest('TEST 10 — no -N version suffix in member identity or path', () => {
        const paths = buildExpectedMemberSourcePaths(METADATA_TYPE, METADATA_NAME);

        assert.ok(!paths.logical.includes('My_Flow-1'));
        assert.ok(!paths.logical.includes('My_Flow-'));
        assert.strictEqual(usesToolingApi('Flow'), true);
    });

    await runTest('TEST 11 — Flow is capture allowlisted', () => {
        assert.strictEqual(isCaptureAllowlisted(METADATA_TYPE), true);
    });

    await runTest('TEST 12 — NEW capture shape uses ABSENT_PROVEN (no delete rollback in Phase 1)', async () => {
        const afterBytes = packFlowXml(FLOW_XML);
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
