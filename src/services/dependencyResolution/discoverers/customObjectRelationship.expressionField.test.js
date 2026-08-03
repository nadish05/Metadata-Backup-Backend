const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./customObjectRelationship.discoverer');

const {
    parseRelationshipFromFieldXml,
    extractExpressionCustomFieldNames,
    discoverExpressionFieldDependencies
} = customObjectRelationshipDiscoverer;

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

function namesOf(relationships) {
    return (relationships || []).map((item) => item.name).sort();
}

function customFieldNames(relationships) {
    return (relationships || [])
        .filter((item) => item.metadataType === 'CustomField')
        .map((item) => item.name)
        .sort();
}

const FORMULA_SAME_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <type>Formula</type>
    <formula>IF(Is_Canceled__c, "Canceled", "Active")</formula>
    <formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>
    <label>Status</label>
</CustomField>`;

const FORMULA_PARENT_RELATIONSHIP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session_Canceled__c</fullName>
    <type>Formula</type>
    <formula>Session__r.Is_Canceled__c</formula>
    <label>Session Canceled</label>
</CustomField>`;

const FORMULA_MULTIPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Rating__c</fullName>
    <type>Formula</type>
    <formula>IF(
  ISPICKVAL(Status__c, "Active"),
  Sum_of_Guest_Reviews__c / Number_of_Guests__c,
  0
)</formula>
    <label>Rating</label>
</CustomField>`;

const FORMULA_DUPLICATE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Dup__c</fullName>
    <type>Formula</type>
    <formula>Is_Canceled__c || Is_Canceled__c</formula>
    <label>Dup</label>
</CustomField>`;

const FORMULA_STANDARD_AND_FUNCTIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Label__c</fullName>
    <type>Formula</type>
    <formula>IF(ISPICKVAL(Status__c, "Open"), CASE(Name, "A", 1, 0), CreatedDate)</formula>
    <label>Label</label>
</CustomField>`;

const SUMMARY_WITH_FILTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <summarizedField>Number_of_Guests__c</summarizedField>
    <summaryOperation>sum</summaryOperation>
    <summaryFilterItems>
        <field>Booking__c.Is_Canceled__c</field>
        <operation>equals</operation>
        <value>false</value>
    </summaryFilterItems>
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

const SESSION_LOOKUP_ON_BOOKING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session__c</fullName>
    <type>Lookup</type>
    <referenceTo>Session__c</referenceTo>
    <label>Session</label>
</CustomField>`;

const REPO_FILES = [
    'force-app/main/default/objects/Booking__c/fields/Status__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session_Canceled__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Dup__c.field-meta.xml',
    'force-app/main/default/objects/Experience__c/fields/Rating__c.field-meta.xml',
    'force-app/main/default/objects/Experience__c/fields/Label__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Master_Detail_Probe__c.field-meta.xml'
];

const fileContents = {
    'force-app/main/default/objects/Booking__c/fields/Status__c.field-meta.xml':
        FORMULA_SAME_OBJECT_XML,
    'force-app/main/default/objects/Booking__c/fields/Session_Canceled__c.field-meta.xml':
        FORMULA_PARENT_RELATIONSHIP_XML,
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml':
        SESSION_LOOKUP_ON_BOOKING_XML,
    'force-app/main/default/objects/Booking__c/fields/Dup__c.field-meta.xml':
        FORMULA_DUPLICATE_XML,
    'force-app/main/default/objects/Experience__c/fields/Rating__c.field-meta.xml':
        FORMULA_MULTIPLE_XML,
    'force-app/main/default/objects/Experience__c/fields/Label__c.field-meta.xml':
        FORMULA_STANDARD_AND_FUNCTIONS_XML,
    'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml':
        SUMMARY_WITH_FILTER_XML,
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml':
        LOOKUP_FIELD_XML,
    'force-app/main/default/objects/Booking__c/fields/Master_Detail_Probe__c.field-meta.xml':
        MASTER_DETAIL_FIELD_XML
};

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    const content = fileContents[normalized];

    if (!content) {
        throw new Error(`Unexpected file read: ${filePath}`);
    }

    return content;
}

async function main() {
    await runTest(
        'Formula references same-object custom field',
        async () => {
            const names = extractExpressionCustomFieldNames(
                FORMULA_SAME_OBJECT_XML,
                'Booking__c'
            );

            assert.deepStrictEqual(names.sort(), [
                'Booking__c.Is_Canceled__c'
            ]);

            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Status__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.ok(
                customFieldNames(result.relationships).includes(
                    'Booking__c.Is_Canceled__c'
                )
            );
        }
    );

    await runTest(
        'Formula references parent relationship custom field',
        async () => {
            const relationshipTargetMap = new Map([
                ['Session__r', 'Session__c']
            ]);

            const names = extractExpressionCustomFieldNames(
                FORMULA_PARENT_RELATIONSHIP_XML,
                'Booking__c',
                relationshipTargetMap
            );

            assert.deepStrictEqual(names.sort(), [
                'Session__c.Is_Canceled__c'
            ]);

            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Session_Canceled__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.ok(
                customFieldNames(result.relationships).includes(
                    'Session__c.Is_Canceled__c'
                )
            );
        }
    );

    await runTest('Multiple referenced custom fields', async () => {
        const names = extractExpressionCustomFieldNames(
            FORMULA_MULTIPLE_XML,
            'Experience__c'
        );

        assert.deepStrictEqual(names.sort(), [
            'Experience__c.Number_of_Guests__c',
            'Experience__c.Status__c',
            'Experience__c.Sum_of_Guest_Reviews__c'
        ]);
    });

    await runTest('Duplicate references collapse', async () => {
        const deps = discoverExpressionFieldDependencies({
            fieldXml: FORMULA_DUPLICATE_XML,
            ownerObjectApiName: 'Booking__c',
            sourceField: 'Dup__c',
            sourceMetadata: 'Booking__c'
        });

        assert.strictEqual(deps.length, 1);
        assert.strictEqual(deps[0].name, 'Booking__c.Is_Canceled__c');
        assert.strictEqual(deps[0].metadataType, 'CustomField');
    });

    await runTest('Standard fields ignored', async () => {
        const names = extractExpressionCustomFieldNames(
            FORMULA_STANDARD_AND_FUNCTIONS_XML,
            'Experience__c'
        );

        assert.deepStrictEqual(names.sort(), ['Experience__c.Status__c']);
        assert.ok(!names.includes('Experience__c.Name'));
        assert.ok(!names.some((name) => name.endsWith('.CreatedDate')));
    });

    await runTest(
        'Formula with IF(), CASE(), ISPICKVAL() still extracts custom fields',
        async () => {
            const names = extractExpressionCustomFieldNames(
                FORMULA_STANDARD_AND_FUNCTIONS_XML,
                'Experience__c'
            );

            assert.ok(names.includes('Experience__c.Status__c'));
        }
    );

    await runTest(
        'Summary filter expression emits Booking__c.Is_Canceled__c additively',
        async () => {
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

            const fields = customFieldNames(result.relationships);

            assert.ok(fields.includes('Booking__c.Is_Canceled__c'));
            assert.ok(fields.includes('Booking__c.Number_of_Guests__c'));
            assert.ok(fields.includes('Booking__c.Session__c'));
            assert.ok(
                result.relationships.some(
                    (item) =>
                        item.name === 'Booking__c' &&
                        item.metadataType === 'CustomObject'
                )
            );
        }
    );

    await runTest('Existing Lookup behavior unchanged', async () => {
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

        assert.deepStrictEqual(namesOf(result.relationships), [
            'Experience__c'
        ]);
    });

    await runTest('Existing MasterDetail behavior unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(MASTER_DETAIL_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'MasterDetail');
        assert.strictEqual(parsed.referencedObject, 'Session__c');

        const result = await customObjectRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Master_Detail_Probe__c'
                }
            ],
            repoFiles: REPO_FILES,
            readRepoFile
        });

        assert.deepStrictEqual(namesOf(result.relationships), ['Session__c']);
    });
}

main();
