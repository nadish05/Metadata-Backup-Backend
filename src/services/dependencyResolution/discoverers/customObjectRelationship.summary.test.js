const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./customObjectRelationship.discoverer');

const { parseRelationshipFromFieldXml } = customObjectRelationshipDiscoverer;

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

const SUMMARY_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Session__c</summaryForeignKey>
    <summaryOperation>count</summaryOperation>
    <label>Booked Slots</label>
</CustomField>`;

const LOOKUP_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Experience__c</fullName>
    <type>Lookup</type>
    <referenceTo>Experience__c</referenceTo>
    <label>Experience</label>
</CustomField>`;

const MASTER_DETAIL_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Session__c</referenceTo>
    <label>Session</label>
</CustomField>`;

const NUMBER_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Capacity__c</fullName>
    <type>Number</type>
    <label>Capacity</label>
</CustomField>`;

const SUMMARY_MISSING_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summaryForeignKey>Session__c</summaryForeignKey>
    <summaryOperation>count</summaryOperation>
</CustomField>`;

const SUMMARY_MISSING_FK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryOperation>count</summaryOperation>
</CustomField>`;

const REPO_FILES = [
    'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Capacity__c.field-meta.xml'
];

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    if (normalized.endsWith('/Session__c/fields/Booked_Slots__c.field-meta.xml')) {
        return SUMMARY_FIELD_XML;
    }

    if (normalized.endsWith('/Session__c/fields/Experience__c.field-meta.xml')) {
        return LOOKUP_FIELD_XML;
    }

    if (normalized.endsWith('/Booking__c/fields/Session__c.field-meta.xml')) {
        return MASTER_DETAIL_FIELD_XML;
    }

    if (normalized.endsWith('/Session__c/fields/Capacity__c.field-meta.xml')) {
        return NUMBER_FIELD_XML;
    }

    throw new Error(`Unexpected file read: ${filePath}`);
}

async function main() {
    await runTest('Summary field discovers CustomObject Booking__c', async () => {
        const parsed = parseRelationshipFromFieldXml(SUMMARY_FIELD_XML);

        assert.ok(parsed);
        assert.strictEqual(parsed.relationship, 'Summary');
        assert.strictEqual(parsed.referencedObject, 'Booking__c');

        const result = await customObjectRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Booked_Slots__c'
                }
            ],
            repoFiles: REPO_FILES,
            readRepoFile
        });

        assert.strictEqual(result.relationships.length, 1);
        assert.strictEqual(result.relationships[0].name, 'Booking__c');
        assert.strictEqual(result.relationships[0].metadataType, 'CustomObject');
        assert.strictEqual(result.relationships[0].type, 'CustomObject');
        assert.strictEqual(result.relationships[0].relationship, 'Summary');
        assert.strictEqual(result.relationships[0].required, true);
        assert.strictEqual(result.relationships[0].selected, true);
        assert.strictEqual(
            result.relationships[0].discoveredBy,
            'CustomObjectRelationshipDiscoverer'
        );
        assert.strictEqual(result.relationships[0].sourceField, 'Booked_Slots__c');
        assert.strictEqual(result.relationships[0].sourceMetadata, 'Session__c');

        // Must not emit parent Session__c as a discovered relationship target.
        assert.ok(
            !result.relationships.some(
                (item) =>
                    item.name === 'Session__c' && item.metadataType === 'CustomObject'
            )
        );
    });

    await runTest('Lookup behavior unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(LOOKUP_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'Lookup');
        assert.strictEqual(parsed.referencedObject, 'Experience__c');

        const result = await customObjectRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Experience__c'
                }
            ],
            repoFiles: REPO_FILES,
            readRepoFile
        });

        assert.strictEqual(result.relationships.length, 1);
        assert.strictEqual(result.relationships[0].name, 'Experience__c');
        assert.strictEqual(result.relationships[0].relationship, 'Lookup');
    });

    await runTest('MasterDetail behavior unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(MASTER_DETAIL_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'MasterDetail');
        assert.strictEqual(parsed.referencedObject, 'Session__c');

        const result = await customObjectRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Session__c'
                }
            ],
            repoFiles: REPO_FILES,
            readRepoFile
        });

        assert.strictEqual(result.relationships.length, 1);
        assert.strictEqual(result.relationships[0].name, 'Session__c');
        assert.strictEqual(result.relationships[0].relationship, 'MasterDetail');
    });

    await runTest('Non-summary fields unchanged', async () => {
        assert.strictEqual(parseRelationshipFromFieldXml(NUMBER_FIELD_XML), null);

        const result = await customObjectRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Capacity__c'
                }
            ],
            repoFiles: REPO_FILES,
            readRepoFile
        });

        assert.strictEqual(result.relationships.length, 0);
    });

    await runTest('Malformed Summary returns no relationship', async () => {
        assert.strictEqual(
            parseRelationshipFromFieldXml(SUMMARY_MISSING_OBJECT_XML),
            null
        );
        assert.strictEqual(
            parseRelationshipFromFieldXml(SUMMARY_MISSING_FK_XML),
            null
        );
        assert.strictEqual(
            parseRelationshipFromFieldXml(
                `<CustomField><type>Summary</type></CustomField>`
            ),
            null
        );
    });
}

main();
