const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./customObjectRelationship.discoverer');

const {
    discoverInternalObjectDependencies,
    parseRelationshipFromFieldXml
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
    return relationships.map((item) => item.name).sort();
}

async function main() {
    await runTest('Test 1 — searchResultsFields discovers CustomField', () => {
        const xml = `
<CustomObject>
    <searchResultsFields>Experience_Name__c</searchResultsFields>
</CustomObject>`;

        const deps = discoverInternalObjectDependencies(xml, 'Booking__c');

        assert.strictEqual(deps.length, 1);
        assert.strictEqual(deps[0].name, 'Booking__c.Experience_Name__c');
        assert.strictEqual(deps[0].metadataType, 'CustomField');
        assert.strictEqual(deps[0].type, 'CustomField');
        assert.strictEqual(deps[0].relationship, 'searchResultsFields');
        assert.strictEqual(deps[0].sourceMetadata, 'Booking__c');
        assert.strictEqual(deps[0].required, true);
        assert.strictEqual(deps[0].selected, true);
    });

    await runTest('Test 2 — multiple searchResultsFields', () => {
        const xml = `
<CustomObject>
    <searchResultsFields>Experience_Name__c</searchResultsFields>
    <searchResultsFields>Status__c</searchResultsFields>
    <searchResultsAdditionalFields>Capacity__c</searchResultsAdditionalFields>
</CustomObject>`;

        const deps = discoverInternalObjectDependencies(xml, 'Booking__c');

        assert.deepStrictEqual(namesOf(deps), [
            'Booking__c.Capacity__c',
            'Booking__c.Experience_Name__c',
            'Booking__c.Status__c'
        ]);
    });

    await runTest('Test 3 — standard fields ignored', () => {
        const xml = `
<CustomObject>
    <searchResultsFields>Name</searchResultsFields>
    <searchResultsFields>Id</searchResultsFields>
    <searchResultsFields>OwnerId</searchResultsFields>
    <searchResultsFields>CreatedDate</searchResultsFields>
    <searchResultsFields>Experience_Name__c</searchResultsFields>
</CustomObject>`;

        const deps = discoverInternalObjectDependencies(xml, 'Booking__c');

        assert.deepStrictEqual(namesOf(deps), [
            'Booking__c.Experience_Name__c'
        ]);
    });

    await runTest('Test 4 — duplicate field references emitted once', () => {
        const xml = `
<CustomObject>
    <searchResultsFields>Experience_Name__c</searchResultsFields>
    <searchResultsFields>Experience_Name__c</searchResultsFields>
    <compactLayouts>
        <fields>Experience_Name__c</fields>
    </compactLayouts>
</CustomObject>`;

        const deps = discoverInternalObjectDependencies(xml, 'Booking__c');

        assert.strictEqual(deps.length, 1);
        assert.strictEqual(deps[0].name, 'Booking__c.Experience_Name__c');
    });

    await runTest('Test 5 — compactLayouts discovers custom fields', () => {
        const xml = `
<CustomObject>
    <compactLayouts>
        <fullName>Booking_Compact</fullName>
        <fields>Experience_Name__c</fields>
        <fields>Status__c</fields>
        <fields>Name</fields>
    </compactLayouts>
</CustomObject>`;

        const deps = discoverInternalObjectDependencies(xml, 'Booking__c');

        assert.deepStrictEqual(namesOf(deps), [
            'Booking__c.Experience_Name__c',
            'Booking__c.Status__c'
        ]);
        assert.ok(deps.every((item) => item.relationship === 'compactLayouts'));
        assert.ok(
            !deps.some((item) => item.metadataType === 'CompactLayout')
        );
    });

    await runTest('Test 6 — recordTypes discovers custom fields only', () => {
        const xml = `
<CustomObject>
    <recordTypes>
        <fullName>Active</fullName>
        <label>Active</label>
        <Experience_Name__c>true</Experience_Name__c>
        <fields>Status__c</fields>
    </recordTypes>
</CustomObject>`;

        const deps = discoverInternalObjectDependencies(xml, 'Booking__c');

        assert.ok(namesOf(deps).includes('Booking__c.Experience_Name__c'));
        assert.ok(namesOf(deps).includes('Booking__c.Status__c'));
        assert.ok(deps.every((item) => item.metadataType === 'CustomField'));
        assert.ok(!deps.some((item) => item.name === 'Active'));
        assert.ok(!deps.some((item) => item.metadataType === 'RecordType'));
    });

    await runTest(
        'Test 7 — nameField custom field discovered; AutoNumber ignored',
        () => {
            const customNameXml = `
<CustomObject>
    <nameField>
        <type>Text</type>
        <fullName>Booking_Title__c</fullName>
    </nameField>
</CustomObject>`;

            const customDeps = discoverInternalObjectDependencies(
                customNameXml,
                'Booking__c'
            );

            assert.deepStrictEqual(namesOf(customDeps), [
                'Booking__c.Booking_Title__c'
            ]);
            assert.strictEqual(customDeps[0].relationship, 'nameField');

            const autoNumberXml = `
<CustomObject>
    <nameField>
        <type>AutoNumber</type>
        <displayFormat>B-{0000}</displayFormat>
        <fullName>Booking_Title__c</fullName>
    </nameField>
</CustomObject>`;

            const autoDeps = discoverInternalObjectDependencies(
                autoNumberXml,
                'Booking__c'
            );

            assert.deepStrictEqual(autoDeps, []);
        }
    );

    await runTest('Regression — Lookup parse unchanged', () => {
        const parsed = parseRelationshipFromFieldXml(`
<CustomField>
    <type>Lookup</type>
    <referenceTo>Experience__c</referenceTo>
</CustomField>`);

        assert.strictEqual(parsed.relationship, 'Lookup');
        assert.strictEqual(parsed.referencedObject, 'Experience__c');
    });

    await runTest('Regression — MasterDetail parse unchanged', () => {
        const parsed = parseRelationshipFromFieldXml(`
<CustomField>
    <type>MasterDetail</type>
    <referenceTo>Session__c</referenceTo>
</CustomField>`);

        assert.strictEqual(parsed.relationship, 'MasterDetail');
        assert.strictEqual(parsed.referencedObject, 'Session__c');
    });

    await runTest('Regression — Summary FK variant unchanged', () => {
        const parsed = parseRelationshipFromFieldXml(`
<CustomField>
    <type>Summary</type>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
</CustomField>`);

        assert.strictEqual(parsed.relationship, 'Summary');
        assert.strictEqual(parsed.referencedObject, 'Booking__c');
    });

    await runTest(
        'Discoverer reads object XML and emits internal CustomFields',
        async () => {
            const objectXml = `
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <searchResultsFields>Experience_Name__c</searchResultsFields>
</CustomObject>`;

            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Booking__c'
                    }
                ],
                repoFiles: [
                    'force-app/main/default/objects/Booking__c/Booking__c.object-meta.xml'
                ],
                readRepoFile: async () => objectXml
            });

            assert.ok(
                result.relationships.some(
                    (item) =>
                        item.metadataType === 'CustomField' &&
                        item.name === 'Booking__c.Experience_Name__c'
                )
            );
        }
    );
}

main();
