'use strict';

const assert = require('assert');

const {
    buildSemanticModelFromRecordTypeXml,
    buildRecordTypeSemanticFromWorkspaceArtifact,
    canonicalizeRecordTypeSemanticModel,
    hashRecordTypeSemanticModel
} = require('./recordTypeSemanticExpectedAfter.service');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const {
    compareMemberExpectedAfterDrift,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');
const { EXPECTED_AFTER_REPRESENTATION } = require('./snapshot.types');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise_Deal</fullName>
    <active>true</active>
    <businessProcess>New Sales Process</businessProcess>
    <label>Enterprise Deal</label>
    <picklistValues>
        <picklist>Customer_Field__c</picklist>
        <values><fullName>Event</fullName><default>false</default></values>
        <values><fullName>Referral</fullName><default>false</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>Customer_Status__c</picklist>
        <values><fullName>Active Customer</fullName><default>false</default></values>
        <values><fullName>Prospect</fullName><default>false</default></values>
    </picklistValues>
</RecordType>`;

const REORDERED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise_Deal</fullName>
    <active>true</active>
    <businessProcess>New Sales Process</businessProcess>
    <label>Enterprise Deal</label>
    <picklistValues>
        <picklist>Customer_Status__c</picklist>
        <values><fullName>Prospect</fullName><default>false</default></values>
        <values><fullName>Active Customer</fullName><default>false</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>Customer_Field__c</picklist>
        <values><fullName>Referral</fullName><default>false</default></values>
        <values><fullName>Event</fullName><default>false</default></values>
    </picklistValues>
</RecordType>`;

runTest('semantic canonicalization ignores picklist and value ordering', () => {
    const left = hashRecordTypeSemanticModel(
        buildSemanticModelFromRecordTypeXml(
            BASE_XML,
            'Opportunity.Enterprise_Deal'
        )
    );
    const right = hashRecordTypeSemanticModel(
        buildSemanticModelFromRecordTypeXml(
            REORDERED_XML,
            'Opportunity.Enterprise_Deal'
        )
    );

    assert.strictEqual(left.canonicalHash, right.canonicalHash);
});

runTest('meaningful picklist difference changes hash', () => {
    const changed = BASE_XML.replace('Event', 'Expo');
    const left = hashRecordTypeSemanticModel(
        buildSemanticModelFromRecordTypeXml(
            BASE_XML,
            'Opportunity.Enterprise_Deal'
        )
    );
    const right = hashRecordTypeSemanticModel(
        buildSemanticModelFromRecordTypeXml(
            changed,
            'Opportunity.Enterprise_Deal'
        )
    );

    assert.notStrictEqual(left.canonicalHash, right.canonicalHash);
});

runTest('scalar active difference changes hash', () => {
    const inactive = BASE_XML.replace('<active>true</active>', '<active>false</active>');
    const left = hashRecordTypeSemanticModel(
        buildSemanticModelFromRecordTypeXml(
            BASE_XML,
            'Opportunity.Enterprise_Deal'
        )
    );
    const right = hashRecordTypeSemanticModel(
        buildSemanticModelFromRecordTypeXml(
            inactive,
            'Opportunity.Enterprise_Deal'
        )
    );

    assert.notStrictEqual(left.canonicalHash, right.canonicalHash);
});

runTest('workspace artifact pack produces capture spec with sorted picklists', () => {
    const artifactBytes = packMemberFiles([
        {
            relativePath:
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml',
            bytes: Buffer.from(BASE_XML, 'utf8')
        }
    ]);
    const built = buildRecordTypeSemanticFromWorkspaceArtifact(
        artifactBytes,
        'Opportunity.Enterprise_Deal'
    );

    assert.deepStrictEqual(built.captureSpec.picklistFieldApiNames, [
        'Customer_Field__c',
        'Customer_Status__c'
    ]);
    assert.ok(built.canonicalHash);
});

runTest('RecordType semantic drift C=A raw does not return UNCHANGED_FROM_BEFORE', () => {
    const built = buildRecordTypeSemanticFromWorkspaceArtifact(
        packMemberFiles([
            {
                relativePath:
                    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml',
                bytes: Buffer.from(BASE_XML, 'utf8')
            }
        ]),
        'Opportunity.Enterprise_Deal'
    );
    const rawA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = compareMemberExpectedAfterDrift({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal',
        destinationBeforeHash: rawA,
        expectedAfterHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        canonicalExpectedAfterHash: built.canonicalHash,
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1,
        currentDestinationHash: rawA,
        recordTypeSemanticCaptureSpec: built.captureSpec,
        currentRecordTypeSemanticHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    });

    assert.notStrictEqual(
        result.classification,
        DRIFT_CLASSIFICATION.UNCHANGED_FROM_BEFORE
    );
    assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
});

runTest('missing destination semantic hash is UNKNOWN fail-closed', () => {
    const built = buildRecordTypeSemanticFromWorkspaceArtifact(
        packMemberFiles([
            {
                relativePath:
                    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml',
                bytes: Buffer.from(BASE_XML, 'utf8')
            }
        ]),
        'Opportunity.Enterprise_Deal'
    );
    const result = compareMemberExpectedAfterDrift({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal',
        expectedAfterHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        canonicalExpectedAfterHash: built.canonicalHash,
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1,
        currentDestinationHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        recordTypeSemanticCaptureSpec: built.captureSpec
    });

    assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.UNKNOWN);
    assert.strictEqual(result.failClosed, true);
});

runTest('RAW RecordType snapshot still uses UNCHANGED_FROM_BEFORE when C=A', () => {
    const rawA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const rawB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = compareMemberExpectedAfterDrift({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal',
        destinationBeforeHash: rawA,
        expectedAfterHash: rawB,
        expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW,
        currentDestinationHash: rawA
    });

    assert.strictEqual(
        result.classification,
        DRIFT_CLASSIFICATION.UNCHANGED_FROM_BEFORE
    );
});

runTest('semantic match returns MATCHES_EXPECTED_AFTER', () => {
    const built = buildRecordTypeSemanticFromWorkspaceArtifact(
        packMemberFiles([
            {
                relativePath:
                    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml',
                bytes: Buffer.from(BASE_XML, 'utf8')
            }
        ]),
        'Opportunity.Enterprise_Deal'
    );
    const result = compareMemberExpectedAfterDrift({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal',
        expectedAfterHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        canonicalExpectedAfterHash: built.canonicalHash,
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1,
        currentDestinationHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        recordTypeSemanticCaptureSpec: built.captureSpec,
        currentRecordTypeSemanticHash: built.canonicalHash
    });

    assert.strictEqual(
        result.classification,
        DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
    );
});
