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

function customFieldNames(relationships) {
    return (relationships || [])
        .filter((item) => item.metadataType === 'CustomField')
        .map((item) => item.name)
        .sort();
}

const SUMMARY_QUALIFIED_FK_AND_SUMMARIZED_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <summarizedField>Number_of_Guests__c</summarizedField>
    <summaryOperation>sum</summaryOperation>
    <label>Booked Slots</label>
</CustomField>`;

const SUMMARY_QUALIFIED_FK_WITHOUT_SUMMARIZED_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <summaryOperation>count</summaryOperation>
    <label>Booked Slots</label>
</CustomField>`;

const SUMMARY_OBJECT_AND_UNQUALIFIED_FK_XML = `<?xml version="1.0" encoding="UTF-8"?>
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

let bookedSlotsXml = SUMMARY_QUALIFIED_FK_AND_SUMMARIZED_FIELD_XML;

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
        'qualified summaryForeignKey emits object, summarizedField, and FK CustomField',
        async () => {
            bookedSlotsXml = SUMMARY_QUALIFIED_FK_AND_SUMMARIZED_FIELD_XML;

            const parsed = parseRelationshipFromFieldXml(
                SUMMARY_QUALIFIED_FK_AND_SUMMARIZED_FIELD_XML
            );

            assert.ok(parsed);
            assert.strictEqual(parsed.referencedObject, 'Booking__c');
            assert.strictEqual(parsed.summarizedField, 'Number_of_Guests__c');
            assert.strictEqual(
                parsed.summaryForeignKeyField,
                'Booking__c.Session__c'
            );

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

            assert.strictEqual(result.relationships.length, 3);
            assert.ok(findByName(result.relationships, 'Booking__c'));
            assert.strictEqual(
                findByName(result.relationships, 'Booking__c').metadataType,
                'CustomObject'
            );
            assert.deepStrictEqual(customFieldNames(result.relationships), [
                'Booking__c.Number_of_Guests__c',
                'Booking__c.Session__c'
            ]);
        }
    );

    await runTest(
        'summarizedField absent still emits object and FK CustomField',
        async () => {
            bookedSlotsXml = SUMMARY_QUALIFIED_FK_WITHOUT_SUMMARIZED_FIELD_XML;

            const parsed = parseRelationshipFromFieldXml(
                SUMMARY_QUALIFIED_FK_WITHOUT_SUMMARIZED_FIELD_XML
            );

            assert.ok(parsed);
            assert.strictEqual(parsed.referencedObject, 'Booking__c');
            assert.strictEqual(parsed.summarizedField, null);
            assert.strictEqual(
                parsed.summaryForeignKeyField,
                'Booking__c.Session__c'
            );

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
                findByName(result.relationships, 'Booking__c.Session__c')
            );
            assert.strictEqual(
                findByName(result.relationships, 'Booking__c.Session__c')
                    .metadataType,
                'CustomField'
            );
            assert.ok(
                !result.relationships.some(
                    (item) => item.name === 'Booking__c.Number_of_Guests__c'
                )
            );
        }
    );

    await runTest(
        'malformed summaryForeignKey keeps existing behavior without exception',
        async () => {
            assert.doesNotThrow(() => {
                assert.strictEqual(
                    parseRelationshipFromFieldXml(
                        `<CustomField><type>Summary</type><summaryForeignKey></summaryForeignKey></CustomField>`
                    ),
                    null
                );
            });

            assert.doesNotThrow(() => {
                // Object-only FK cannot resolve child object without summarizedObject.
                assert.strictEqual(
                    parseRelationshipFromFieldXml(
                        `<CustomField><type>Summary</type><summaryForeignKey>Booking__c</summaryForeignKey></CustomField>`
                    ),
                    null
                );
            });

            assert.doesNotThrow(() => {
                assert.strictEqual(
                    parseRelationshipFromFieldXml(
                        `<CustomField><type>Summary</type><summaryForeignKey>Session__c</summaryForeignKey></CustomField>`
                    ),
                    null
                );
            });

            bookedSlotsXml = SUMMARY_OBJECT_AND_UNQUALIFIED_FK_XML;

            const parsed = parseRelationshipFromFieldXml(
                SUMMARY_OBJECT_AND_UNQUALIFIED_FK_XML
            );

            assert.ok(parsed);
            assert.strictEqual(parsed.referencedObject, 'Booking__c');
            assert.strictEqual(parsed.summaryForeignKeyField, null);

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
            assert.ok(
                !result.relationships.some(
                    (item) => item.metadataType === 'CustomField'
                )
            );
        }
    );

    await runTest(
        'duplicate prevention — same FK CustomField emitted once per discover call',
        async () => {
            bookedSlotsXml = SUMMARY_QUALIFIED_FK_AND_SUMMARIZED_FIELD_XML;

            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Booked_Slots__c'
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Booked_Slots__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            const sessionFields = result.relationships.filter(
                (item) => item.name === 'Booking__c.Session__c'
            );
            const guestFields = result.relationships.filter(
                (item) => item.name === 'Booking__c.Number_of_Guests__c'
            );
            const objects = result.relationships.filter(
                (item) => item.name === 'Booking__c'
            );

            // scannedFieldPaths dedupes the same field file within one discover().
            assert.strictEqual(sessionFields.length, 1);
            assert.strictEqual(guestFields.length, 1);
            assert.strictEqual(objects.length, 1);
        }
    );

    await runTest('Lookup regression unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(LOOKUP_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'Lookup');
        assert.strictEqual(parsed.referencedObject, 'Experience__c');
        assert.strictEqual(parsed.summaryForeignKeyField, undefined);

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

    await runTest('MasterDetail regression unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(MASTER_DETAIL_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'MasterDetail');
        assert.strictEqual(parsed.referencedObject, 'Session__c');
        assert.strictEqual(parsed.summaryForeignKeyField, undefined);

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
}

main();
