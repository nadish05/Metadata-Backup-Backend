'use strict';

const assert = require('assert');

const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    CANONICALIZATION_VERSION,
    canonicalizeForRollback
} = require('./rollbackMetadataCanonicalizer.service');
const {
    EXPECTED_AFTER_REPRESENTATION
} = require('./snapshot.types');
const {
    EXISTING_MEMBER_CHANGE,
    classifyExistingMemberChange
} = require('./effectiveMemberChange.service');

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

const FIELD_PATH =
    'force-app/main/default/objects/Vehicle__c/fields/Model__c.field-meta.xml';
const OBJECT_PATH =
    'force-app/main/default/objects/Vehicle__c/Vehicle__c.object-meta.xml';
const FIELD_NAME = 'Vehicle__c.Model__c';
const OBJECT_NAME = 'Vehicle__c';
const APEX_PATH = 'force-app/main/default/classes/AccountService.cls';

function packXml(relativePath, xml) {
    return packMemberFiles([
        {
            relativePath,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

const fieldWithDeprecatedFalse = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Model__c</fullName>
    <deprecated>false</deprecated>
    <label>Model</label>
    <type>Text</type>
</CustomField>`;

const fieldWithoutDeprecated = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Model__c</fullName>
    <label>Model</label>
    <type>Text</type>
</CustomField>`;

const objectWithDeprecatedFalse = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Vehicle__c</fullName>
    <deprecated>false</deprecated>
    <deploymentStatus>Deployed</deploymentStatus>
</CustomObject>`;

const objectWithoutDeprecated = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Vehicle__c</fullName>
    <deploymentStatus>Deployed</deploymentStatus>
</CustomObject>`;

function canonicalHash(metadataType, metadataName, filePath, xml) {
    const packed = packXml(filePath, xml);
    return canonicalizeForRollback({
        metadataType,
        metadataName,
        filePath,
        artifactBytes: packed,
        canonicalizationVersion: CANONICALIZATION_VERSION
    }).canonicalHash;
}

runTest('TEST 1 classifier — ApexClass RAW equal → UNCHANGED', () => {
    const bytes = packMemberFiles([
        {
            relativePath: APEX_PATH,
            bytes: Buffer.from('public class AccountService {}', 'utf8')
        }
    ]);
    const result = classifyExistingMemberChange({
        metadataType: 'ApexClass',
        metadataName: 'AccountService',
        filePath: APEX_PATH,
        destinationBeforeArtifactBytes: bytes,
        expectedAfterArtifactBytes: bytes,
        expectedAfterHash: hashBytes(bytes)
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
});

runTest('TEST 2 classifier — ApexClass RAW different → MODIFIED', () => {
    const before = packMemberFiles([
        {
            relativePath: APEX_PATH,
            bytes: Buffer.from('public class AccountService { void old() {} }', 'utf8')
        }
    ]);
    const after = packMemberFiles([
        {
            relativePath: APEX_PATH,
            bytes: Buffer.from('public class AccountService { void new() {} }', 'utf8')
        }
    ]);
    const result = classifyExistingMemberChange({
        metadataType: 'ApexClass',
        metadataName: 'AccountService',
        filePath: APEX_PATH,
        destinationBeforeArtifactBytes: before,
        expectedAfterArtifactBytes: after,
        expectedAfterHash: hashBytes(after)
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.MODIFIED);
});

runTest('TEST 3 classifier — CustomObject RAW equal → UNCHANGED', () => {
    const bytes = packXml(OBJECT_PATH, objectWithoutDeprecated);
    const result = classifyExistingMemberChange({
        metadataType: 'CustomObject',
        metadataName: OBJECT_NAME,
        filePath: OBJECT_PATH,
        destinationBeforeArtifactBytes: bytes,
        expectedAfterArtifactBytes: bytes,
        expectedAfterHash: hashBytes(bytes),
        canonicalExpectedAfterHash: canonicalHash(
            'CustomObject',
            OBJECT_NAME,
            OBJECT_PATH,
            objectWithoutDeprecated
        ),
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
});

runTest('TEST 4 classifier — CustomObject canonical equal, RAW differs → UNCHANGED', () => {
    const before = packXml(OBJECT_PATH, objectWithoutDeprecated);
    const after = packXml(OBJECT_PATH, objectWithDeprecatedFalse);
    const canonical = canonicalHash(
        'CustomObject',
        OBJECT_NAME,
        OBJECT_PATH,
        objectWithDeprecatedFalse
    );

    const result = classifyExistingMemberChange({
        metadataType: 'CustomObject',
        metadataName: OBJECT_NAME,
        filePath: OBJECT_PATH,
        destinationBeforeArtifactBytes: before,
        expectedAfterArtifactBytes: after,
        expectedAfterHash: hashBytes(after),
        canonicalExpectedAfterHash: canonical,
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
});

runTest('TEST 5b classifier — CustomField canonicalization failure → UNKNOWN', () => {
    const before = packXml(FIELD_PATH, '<not-valid-xml');
    const after = packXml(FIELD_PATH, fieldWithDeprecatedFalse);
    const canonical = canonicalHash(
        'CustomField',
        FIELD_NAME,
        FIELD_PATH,
        fieldWithDeprecatedFalse
    );

    const result = classifyExistingMemberChange({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        destinationBeforeArtifactBytes: before,
        expectedAfterArtifactBytes: after,
        expectedAfterHash: hashBytes(after),
        canonicalExpectedAfterHash: canonical,
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNKNOWN);
    assert.match(result.detail, /canonical/i);
});

runTest('TEST 5 classifier — CustomObject missing canonical hash → UNKNOWN', () => {
    const before = packXml(OBJECT_PATH, objectWithoutDeprecated);
    const after = packXml(OBJECT_PATH, objectWithDeprecatedFalse);

    const result = classifyExistingMemberChange({
        metadataType: 'CustomObject',
        metadataName: OBJECT_NAME,
        filePath: OBJECT_PATH,
        destinationBeforeArtifactBytes: before,
        expectedAfterArtifactBytes: after,
        expectedAfterHash: hashBytes(after),
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNKNOWN);
});

runTest('TEST 6 classifier — CustomField RAW equal → UNCHANGED', () => {
    const bytes = packXml(FIELD_PATH, fieldWithoutDeprecated);
    const result = classifyExistingMemberChange({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        destinationBeforeArtifactBytes: bytes,
        expectedAfterArtifactBytes: bytes,
        expectedAfterHash: hashBytes(bytes),
        canonicalExpectedAfterHash: canonicalHash(
            'CustomField',
            FIELD_NAME,
            FIELD_PATH,
            fieldWithoutDeprecated
        ),
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNCHANGED);
});

runTest('TEST 7 classifier — CustomField changed → MODIFIED', () => {
    const before = packXml(FIELD_PATH, fieldWithoutDeprecated);
    const after = packXml(
        FIELD_PATH,
        fieldWithoutDeprecated.replace('Model', 'Model Number')
    );
    const canonical = canonicalHash(
        'CustomField',
        FIELD_NAME,
        FIELD_PATH,
        fieldWithoutDeprecated.replace('Model', 'Model Number')
    );

    const result = classifyExistingMemberChange({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        destinationBeforeArtifactBytes: before,
        expectedAfterArtifactBytes: after,
        expectedAfterHash: hashBytes(after),
        canonicalExpectedAfterHash: canonical,
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.MODIFIED);
});

runTest('TEST 10 classifier — RecordType RAW different → MODIFIED', () => {
    const path =
        'force-app/main/default/objects/Vehicle__c/recordTypes/RT.recordType-meta.xml';
    const before = packXml(path, '<RecordType><label>Old</label></RecordType>');
    const after = packXml(path, '<RecordType><label>New</label></RecordType>');

    const result = classifyExistingMemberChange({
        metadataType: 'RecordType',
        metadataName: 'Vehicle__c.RT',
        filePath: path,
        destinationBeforeArtifactBytes: before,
        expectedAfterArtifactBytes: after,
        expectedAfterHash: hashBytes(after)
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.MODIFIED);
});

runTest('TEST 11 classifier — missing before artifact → UNKNOWN', () => {
    const after = packXml(FIELD_PATH, fieldWithoutDeprecated);

    const result = classifyExistingMemberChange({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        destinationBeforeArtifactBytes: Buffer.alloc(0),
        expectedAfterArtifactBytes: after,
        expectedAfterHash: hashBytes(after)
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNKNOWN);
});

runTest('TEST 12 classifier — missing expected-after artifact → UNKNOWN', () => {
    const before = packXml(FIELD_PATH, fieldWithoutDeprecated);

    const result = classifyExistingMemberChange({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        destinationBeforeArtifactBytes: before,
        expectedAfterArtifactBytes: Buffer.alloc(0),
        expectedAfterHash: hashBytes(before)
    });

    assert.strictEqual(result.classification, EXISTING_MEMBER_CHANGE.UNKNOWN);
});
