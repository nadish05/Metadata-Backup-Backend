'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectExpectedAfterArtifact } = require('./expectedAfterArtifact.service');
const { EXPECTED_AFTER_REPRESENTATION } = require('./snapshot.types');
const { createSnapshotCaptureService } = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    SNAPSHOT_STATUS,
    CHANGE_CLASS,
    SCHEMA_VERSION,
    SNAPSHOT_VERSION
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const { sanitizeMemberForExport } = require('./snapshotExport.service');
const {
    assertSalesforceCanonicalRepresentationSupported
} = require('../controlPlane/controlPlane.snapshotMapping');
const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('../controlPlane/controlPlane.errors');
const {
    buildRecordTypeSemanticFromDestination
} = require('./recordTypeSemanticDestination.service');
const {
    compareMemberExpectedAfterDrift,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');

const RECORD_TYPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise_Deal</fullName>
    <active>true</active>
    <businessProcess>New Sales Process</businessProcess>
    <label>Enterprise Deal</label>
    <picklistValues>
        <picklist>Customer_Field__c</picklist>
        <values><fullName>Event</fullName><default>false</default></values>
    </picklistValues>
</RecordType>`;

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function withWorkspace(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-path-'));
    const relativePath =
        'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml';

    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), RECORD_TYPE_XML, 'utf8');

    try {
        await fn(root, relativePath);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function main() {
    await runTest('expected-after artifact creates semantic RecordType fields', async () => {
        await withWorkspace(async (workspacePath, filePath) => {
            const expectedAfter = await collectExpectedAfterArtifact({
                workspacePath,
                member: {
                    metadataType: 'RecordType',
                    metadataName: 'Opportunity.Enterprise_Deal',
                    filePath
                }
            });

            assert.strictEqual(
                expectedAfter.expectedAfterRepresentation,
                EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1
            );
            assert.ok(expectedAfter.canonicalExpectedAfterHash);
            assert.ok(expectedAfter.recordTypeSemanticCaptureSpec);
            assert.strictEqual(
                expectedAfter.recordTypeSemanticCaptureSpec.developerName,
                'Enterprise_Deal'
            );
            assert.deepStrictEqual(
                expectedAfter.recordTypeSemanticCaptureSpec.picklistFieldApiNames,
                ['Customer_Field__c']
            );
            assert.ok(expectedAfter.expectedAfterHash);
        });
    });

    await runTest('memory snapshot member round-trip preserves semantic fields', async () => {
        await withWorkspace(async (workspacePath, filePath) => {
            const expectedAfter = await collectExpectedAfterArtifact({
                workspacePath,
                member: {
                    metadataType: 'RecordType',
                    metadataName: 'Opportunity.Enterprise_Deal',
                    filePath
                }
            });
            const beforeBytes = packMemberFiles([
                {
                    relativePath: filePath,
                    bytes: Buffer.from('<RecordType><label>Before</label></RecordType>', 'utf8')
                }
            ]);
            const metadataStore = createMemorySnapshotMetadataStore();
            const blobStore = createMemorySnapshotBlobStore();
            const captureService = createSnapshotCaptureService({
                metadataStore,
                blobStore
            });

            const snapshot = await metadataStore.createSnapshot({
                snapshotId: 'snapshot_rt_semantic_path',
                destinationOrgId: '00Dtest',
                status: SNAPSHOT_STATUS.CAPTURING,
                schemaVersion: SCHEMA_VERSION,
                snapshotVersion: SNAPSHOT_VERSION,
                createdAt: new Date().toISOString(),
                rollbackEligible: false,
                memberCount: 0
            });

            await captureService.addMember(snapshot.snapshotId, {
                metadataType: 'RecordType',
                metadataName: 'Opportunity.Enterprise_Deal',
                filePath,
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: beforeBytes,
                expectedAfterHash: expectedAfter.expectedAfterHash,
                expectedAfterRepresentation: expectedAfter.expectedAfterRepresentation,
                canonicalExpectedAfterHash: expectedAfter.canonicalExpectedAfterHash,
                recordTypeSemanticCaptureSpec: expectedAfter.recordTypeSemanticCaptureSpec
            });

            const stored = await metadataStore.getMember(
                snapshot.snapshotId,
                'RecordType',
                'Opportunity.Enterprise_Deal'
            );

            assert.strictEqual(
                stored.expectedAfterRepresentation,
                EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1
            );
            assert.strictEqual(
                stored.canonicalExpectedAfterHash,
                expectedAfter.canonicalExpectedAfterHash
            );
            assert.deepStrictEqual(
                stored.recordTypeSemanticCaptureSpec,
                expectedAfter.recordTypeSemanticCaptureSpec
            );

            const exported = sanitizeMemberForExport(stored);

            assert.strictEqual(
                exported.recordTypeSemanticCaptureSpec.semanticVersion,
                'RECORDTYPE_SEMANTIC_V1'
            );
        });
    });

    await runTest(
        'Salesforce control-plane blocks RECORDTYPE_SEMANTIC_V1 until schema exists',
        async () => {
            assert.throws(
                () =>
                    assertSalesforceCanonicalRepresentationSupported({
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal',
                        expectedAfterRepresentation:
                            EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1,
                        canonicalExpectedAfterHash: hashBytes(Buffer.from('semantic', 'utf8')),
                        recordTypeSemanticCaptureSpec: {
                            semanticVersion: 'RECORDTYPE_SEMANTIC_V1',
                            metadataType: 'RecordType',
                            objectApiName: 'Opportunity',
                            developerName: 'Enterprise_Deal',
                            picklistFieldApiNames: ['Customer_Field__c']
                        }
                    }),
                (error) =>
                    error instanceof ControlPlaneError &&
                    error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH &&
                    String(error.message).includes('RECORDTYPE_SEMANTIC_V1')
            );
        }
    );

    await runTest('RAW RecordType member is not blocked by control-plane assert', async () => {
        assert.doesNotThrow(() =>
            assertSalesforceCanonicalRepresentationSupported({
                metadataType: 'RecordType',
                metadataName: 'Opportunity.Enterprise_Deal',
                expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW,
                expectedAfterHash: hashBytes(Buffer.from('raw', 'utf8'))
            })
        );
    });

    await runTest('FLS or UI API failure yields UNKNOWN not MATCH', async () => {
        await withWorkspace(async (workspacePath, filePath) => {
            const expectedAfter = await collectExpectedAfterArtifact({
                workspacePath,
                member: {
                    metadataType: 'RecordType',
                    metadataName: 'Opportunity.Enterprise_Deal',
                    filePath
                }
            });
            const destBytes = packMemberFiles([
                {
                    relativePath: filePath,
                    bytes: Buffer.from(RECORD_TYPE_XML, 'utf8')
                }
            ]);

            let threw = false;

            try {
                await buildRecordTypeSemanticFromDestination({
                    accessToken: 'invalid',
                    instanceUrl: 'https://invalid.example.com',
                    metadataName: 'Opportunity.Enterprise_Deal',
                    recordTypeSemanticCaptureSpec:
                        expectedAfter.recordTypeSemanticCaptureSpec,
                    destinationArtifactBytes: destBytes
                });
            } catch (error) {
                threw = true;
            }

            assert.strictEqual(threw, true);

            const comparison = compareMemberExpectedAfterDrift({
                metadataType: 'RecordType',
                metadataName: 'Opportunity.Enterprise_Deal',
                expectedAfterHash: expectedAfter.expectedAfterHash,
                canonicalExpectedAfterHash: expectedAfter.canonicalExpectedAfterHash,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1,
                currentDestinationHash: hashBytes(destBytes),
                recordTypeSemanticCaptureSpec:
                    expectedAfter.recordTypeSemanticCaptureSpec,
                currentRecordTypeSemanticHash: null
            });

            assert.strictEqual(comparison.classification, DRIFT_CLASSIFICATION.UNKNOWN);
            assert.notStrictEqual(
                comparison.classification,
                DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );
        });
    });
}

main();
