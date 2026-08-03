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

const SUMMARY_WITH_SUMMARIZED_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Session__c</summaryForeignKey>
    <summaryOperation>count</summaryOperation>
    <label>Booked Slots</label>
</CustomField>`;

const SUMMARY_FK_QUALIFIED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
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

const SUMMARY_MALFORMED_FK_ONLY_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
    <summaryOperation>count</summaryOperation>
</CustomField>`;

const REPO_FILES = [
    'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Capacity__c.field-meta.xml'
];

let bookedSlotsXml = SUMMARY_WITH_SUMMARIZED_OBJECT_XML;

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

    if (normalized.endsWith('/Session__c/fields/Capacity__c.field-meta.xml')) {
        return NUMBER_FIELD_XML;
    }

    throw new Error(`Unexpected file read: ${filePath}`);
}

async function main() {
    await runTest(
        'Case 1 — Summary with summarizedObject discovers Booking__c',
        async () => {
            bookedSlotsXml = SUMMARY_WITH_SUMMARIZED_OBJECT_XML;

            const parsed = parseRelationshipFromFieldXml(
                SUMMARY_WITH_SUMMARIZED_OBJECT_XML
            );

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
            assert.strictEqual(
                result.relationships[0].metadataType,
                'CustomObject'
            );
            assert.strictEqual(result.relationships[0].relationship, 'Summary');
        }
    );

    await runTest(
        'Case 2 — Summary with qualified summaryForeignKey only discovers Booking__c',
        async () => {
            bookedSlotsXml = SUMMARY_FK_QUALIFIED_XML;

            const parsed = parseRelationshipFromFieldXml(SUMMARY_FK_QUALIFIED_XML);

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

            assert.strictEqual(result.relationships.length, 2);
            assert.strictEqual(
                result.relationships.some((item) => item.name === 'Booking__c'),
                true
            );
            assert.strictEqual(
                result.relationships.some(
                    (item) =>
                        item.name === 'Booking__c.Session__c' &&
                        item.metadataType === 'CustomField'
                ),
                true
            );
            assert.strictEqual(result.relationships[0].relationship, 'Summary');
            assert.ok(
                !result.relationships.some((item) => item.name === 'Session__c')
            );
        }
    );

    await runTest('Case 3 — Malformed Summary returns null', async () => {
        assert.strictEqual(
            parseRelationshipFromFieldXml(SUMMARY_MALFORMED_FK_ONLY_XML),
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
}

main();
