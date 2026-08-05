const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./discoverers/customObjectRelationship.discoverer');
const {
    buildInitialFrontier,
    discoverUntilStable,
    EXPANDABLE_DEPENDENCY_TYPES
} = require('./relationshipDiscovery.service');

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

const BOOKING_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Booking</label>
    <searchResultsFields>Experience_Name__c</searchResultsFields>
    <searchResultsAdditionalFields>Contact__c</searchResultsAdditionalFields>
    <nameField>
        <fullName>Name__c</fullName>
        <type>Text</type>
        <label>Booking Name</label>
    </nameField>
</CustomObject>`;

const SESSION_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Session</label>
</CustomObject>`;

const EXPERIENCE_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Experience</label>
</CustomObject>`;

const BOOKING_SESSION_MASTER_DETAIL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Session__c</referenceTo>
    <label>Session</label>
</CustomField>`;

const BOOKING_EXPERIENCE_LOOKUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Experience__c</fullName>
    <type>Lookup</type>
    <referenceTo>Experience__c</referenceTo>
    <label>Experience</label>
</CustomField>`;

const BOOKING_EXPERIENCE_NAME_FORMULA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Experience_Name__c</fullName>
    <type>Formula</type>
    <formula>Experience__r.Experience_Title__c</formula>
    <label>Experience Name</label>
</CustomField>`;

const SESSION_BOOKED_SLOTS_SUMMARY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summarizedField>Number_of_Guests__c</summarizedField>
    <summaryForeignKey>Session__c</summaryForeignKey>
    <summaryOperation>sum</summaryOperation>
    <label>Booked Slots</label>
</CustomField>`;

const FILE_CONTENT = new Map([
    [
        'force-app/main/default/objects/Booking__c/Booking__c.object-meta.xml',
        BOOKING_OBJECT_XML
    ],
    [
        'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml',
        BOOKING_SESSION_MASTER_DETAIL_XML
    ],
    [
        'force-app/main/default/objects/Booking__c/fields/Experience__c.field-meta.xml',
        BOOKING_EXPERIENCE_LOOKUP_XML
    ],
    [
        'force-app/main/default/objects/Booking__c/fields/Experience_Name__c.field-meta.xml',
        BOOKING_EXPERIENCE_NAME_FORMULA_XML
    ],
    [
        'force-app/main/default/objects/Session__c/Session__c.object-meta.xml',
        SESSION_OBJECT_XML
    ],
    [
        'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml',
        SESSION_BOOKED_SLOTS_SUMMARY_XML
    ],
    [
        'force-app/main/default/objects/Experience__c/Experience__c.object-meta.xml',
        EXPERIENCE_OBJECT_XML
    ]
]);

const REPO_FILES = [...FILE_CONTENT.keys()];

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    return FILE_CONTENT.get(normalized) || '';
}

async function listRepoFiles() {
    return REPO_FILES;
}

function namesOf(relationships) {
    return (relationships || []).map((item) => item.name);
}

function customFieldNames(relationships) {
    return (relationships || [])
        .filter((item) => item.metadataType === 'CustomField')
        .map((item) => item.name);
}

async function expandFrom(expandableDependencies, selectedMetadata) {
    return discoverUntilStable({
        selectedMetadata,
        expandableDependencies,
        discoverers: [customObjectRelationshipDiscoverer],
        repoFiles: REPO_FILES,
        readRepoFile,
        listRepoFiles
    });
}

async function main() {
    await runTest(
        'Flow → Booking__c → searchResultsFields → Experience_Name__c',
        async () => {
            const result = await expandFrom(
                [{ type: 'CustomObject', name: 'Booking__c' }],
                [{ metadataType: 'Flow', metadataName: 'Booking_Flow' }]
            );

            const fields = customFieldNames(result.relationships);

            assert.ok(
                fields.includes('Booking__c.Experience_Name__c'),
                `Expected Booking__c.Experience_Name__c in ${JSON.stringify(fields)}`
            );

            const discovered = result.relationships.find(
                (item) => item.name === 'Booking__c.Experience_Name__c'
            );

            assert.strictEqual(discovered.metadataType, 'CustomField');
            assert.strictEqual(discovered.sourceMetadata, 'Booking__c');
            assert.strictEqual(discovered.relationship, 'searchResultsFields');
        }
    );

    await runTest(
        'ApexClass → Booking__c → internal field expansion',
        async () => {
            const result = await expandFrom(
                [{ type: 'CustomObject', name: 'Booking__c' }],
                [{ metadataType: 'ApexClass', metadataName: 'BookingService' }]
            );

            const fields = customFieldNames(result.relationships);

            assert.ok(fields.includes('Booking__c.Experience_Name__c'));
            assert.ok(fields.includes('Booking__c.Contact__c'));
            assert.ok(fields.includes('Booking__c.Name__c'));
        }
    );

    await runTest(
        'Multiple paths discovering Booking__c yield one Experience_Name__c',
        async () => {
            const result = await expandFrom(
                [
                    { type: 'CustomObject', name: 'Booking__c' },
                    { type: 'CustomObject', name: 'Booking__c' },
                    { type: 'CustomField', name: 'Booking__c.Experience_Name__c' }
                ],
                [
                    { metadataType: 'Flow', metadataName: 'Booking_Flow' },
                    { metadataType: 'ApexClass', metadataName: 'BookingService' }
                ]
            );

            const matches = namesOf(result.relationships).filter(
                (name) => name === 'Booking__c.Experience_Name__c'
            );

            assert.strictEqual(matches.length, 1);
        }
    );

    await runTest(
        'Lookup / MasterDetail / Formula / Rollup expansion still works',
        async () => {
            const result = await expandFrom(
                [{ type: 'CustomObject', name: 'Booking__c' }],
                [{ metadataType: 'Flow', metadataName: 'Booking_Flow' }]
            );

            const names = namesOf(result.relationships);
            const byName = (name) =>
                result.relationships.find((item) => item.name === name);

            assert.ok(
                names.includes('Session__c'),
                'MasterDetail target must still expand'
            );
            assert.strictEqual(byName('Session__c').relationship, 'MasterDetail');

            assert.ok(
                names.includes('Experience__c'),
                'Lookup target must still expand'
            );
            assert.strictEqual(byName('Experience__c').relationship, 'Lookup');

            assert.ok(
                names.includes('Booking__c.Experience_Title__c') ||
                    names.includes('Experience__c.Experience_Title__c'),
                `Formula expression field must still expand: ${JSON.stringify(names)}`
            );

            assert.ok(
                names.includes('Booking__c.Number_of_Guests__c'),
                'Roll-up summarized field must still expand'
            );
        }
    );

    await runTest(
        'Regression: Experience_Name__c found when Booking__c enters only via expansion',
        async () => {
            const selectedOnly = await expandFrom(
                [],
                [{ metadataType: 'Flow', metadataName: 'Booking_Flow' }]
            );

            assert.strictEqual(
                selectedOnly.relationships.length,
                0,
                'Flow alone must not discover object internals'
            );

            const withDependency = await expandFrom(
                [{ type: 'CustomObject', name: 'Booking__c' }],
                [{ metadataType: 'Flow', metadataName: 'Booking_Flow' }]
            );

            assert.ok(
                customFieldNames(withDependency.relationships).includes(
                    'Booking__c.Experience_Name__c'
                )
            );

            assert.ok(
                EXPANDABLE_DEPENDENCY_TYPES.includes('CustomObject'),
                'CustomObject dependencies must seed relationship expansion'
            );

            const frontier = buildInitialFrontier(
                [{ metadataType: 'Flow', metadataName: 'Booking_Flow' }],
                [{ type: 'CustomObject', name: 'Booking__c' }]
            );

            assert.ok(
                frontier.some(
                    (item) =>
                        item.metadataType === 'CustomObject' &&
                        item.metadataName === 'Booking__c'
                )
            );
        }
    );
}

main();
