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

function findByName(relationships, name) {
    return (relationships || []).find((item) => item.name === name);
}

const SUMMARY_SUMMARIZED_OBJECT_AND_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summarizedField>Number_of_Guests__c</summarizedField>
    <summaryForeignKey>Session__c</summaryForeignKey>
    <summaryOperation>sum</summaryOperation>
    <label>Booked Slots</label>
</CustomField>`;

const SUMMARY_FK_QUALIFIED_AND_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <summarizedField>Number_of_Guests__c</summarizedField>
    <summaryOperation>sum</summaryOperation>
    <label>Booked Slots</label>
</CustomField>`;

const SUMMARY_OBJECT_WITHOUT_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
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

const REPO_FILES = [
    'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml'
];

let bookedSlotsXml = SUMMARY_SUMMARIZED_OBJECT_AND_FIELD_XML;

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    if (normalized.endsWith('/Session__c/fields/Booked_Slots__c.field-meta.xml')) {
        return bookedSlotsXml;
    }

    if (normalized.endsWith('/Session__c/fields/Experience__c.field-meta.xml')) {
        return LOOKUP_FIELD_XML;
    }

    if (normalized.endsWith('/Booking__c/fields/Session__c.field-meta.xml')) {
        return MASTER_DETAIL_FIELD_XML;
    }

    throw new Error(`Unexpected file read: ${filePath}`);
}

async function main() {
    await runTest(
        'Case 1 — summarizedObject + summarizedField emits CustomObject and CustomField',
        async () => {
            bookedSlotsXml = SUMMARY_SUMMARIZED_OBJECT_AND_FIELD_XML;

            const parsed = parseRelationshipFromFieldXml(
                SUMMARY_SUMMARIZED_OBJECT_AND_FIELD_XML
            );

            assert.ok(parsed);
            assert.strictEqual(parsed.relationship, 'Summary');
            assert.strictEqual(parsed.referencedObject, 'Booking__c');
            assert.strictEqual(parsed.summarizedField, 'Number_of_Guests__c');

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

            assert.strictEqual(result.relationships.length, 2);

            const objectDep = findByName(result.relationships, 'Booking__c');
            const fieldDep = findByName(
                result.relationships,
                'Booking__c.Number_of_Guests__c'
            );

            assert.ok(objectDep);
            assert.strictEqual(objectDep.metadataType, 'CustomObject');
            assert.strictEqual(objectDep.relationship, 'Summary');

            assert.ok(fieldDep);
            assert.strictEqual(fieldDep.metadataType, 'CustomField');
            assert.strictEqual(fieldDep.type, 'CustomField');
            assert.strictEqual(fieldDep.relationship, 'Summary');
            assert.strictEqual(fieldDep.required, true);
            assert.strictEqual(fieldDep.selected, true);
        }
    );

    await runTest(
        'Case 2 — qualified summaryForeignKey + summarizedField emits both dependencies',
        async () => {
            bookedSlotsXml = SUMMARY_FK_QUALIFIED_AND_FIELD_XML;

            const parsed = parseRelationshipFromFieldXml(
                SUMMARY_FK_QUALIFIED_AND_FIELD_XML
            );

            assert.ok(parsed);
            assert.strictEqual(parsed.referencedObject, 'Booking__c');
            assert.strictEqual(parsed.summarizedField, 'Number_of_Guests__c');

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

            assert.strictEqual(result.relationships.length, 2);
            assert.ok(findByName(result.relationships, 'Booking__c'));
            assert.ok(
                findByName(
                    result.relationships,
                    'Booking__c.Number_of_Guests__c'
                )
            );
            assert.strictEqual(
                findByName(result.relationships, 'Booking__c.Number_of_Guests__c')
                    .metadataType,
                'CustomField'
            );
            assert.ok(
                !result.relationships.some((item) => item.name === 'Session__c')
            );
        }
    );

    await runTest(
        'Case 3 — missing summarizedField emits CustomObject only',
        async () => {
            bookedSlotsXml = SUMMARY_OBJECT_WITHOUT_FIELD_XML;

            const parsed = parseRelationshipFromFieldXml(
                SUMMARY_OBJECT_WITHOUT_FIELD_XML
            );

            assert.ok(parsed);
            assert.strictEqual(parsed.referencedObject, 'Booking__c');
            assert.strictEqual(parsed.summarizedField, null);

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
            assert.strictEqual(
                result.relationships[0].metadataType,
                'CustomObject'
            );
            assert.ok(
                !result.relationships.some(
                    (item) => item.metadataType === 'CustomField'
                )
            );
        }
    );

    await runTest('Case 4 — Lookup relationships unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(LOOKUP_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'Lookup');
        assert.strictEqual(parsed.referencedObject, 'Experience__c');
        assert.strictEqual(parsed.summarizedField, undefined);

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
        assert.strictEqual(result.relationships[0].metadataType, 'CustomObject');
        assert.strictEqual(result.relationships[0].relationship, 'Lookup');
    });

    await runTest('Case 5 — MasterDetail relationships unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(MASTER_DETAIL_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'MasterDetail');
        assert.strictEqual(parsed.referencedObject, 'Session__c');
        assert.strictEqual(parsed.summarizedField, undefined);

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
        assert.strictEqual(result.relationships[0].metadataType, 'CustomObject');
        assert.strictEqual(result.relationships[0].relationship, 'MasterDetail');
    });
}

main();
