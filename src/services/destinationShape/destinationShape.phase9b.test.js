const assert = require('assert');

const {
    parseCustomFieldName,
    mapDescribeFieldToAttributes,
    buildShapeKey,
    getShapeEntry,
    serializeDestinationShapeIndex,
    createEmptyDestinationShapeIndex
} = require('./destinationShape.model');
const {
    buildDestinationShapeIndex
} = require('./destinationShapeBuilder.service');

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

async function runAsyncTest(name, fn) {
    try {
        await fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

async function main() {
    runTest('parseCustomFieldName accepts Object.Field', () => {
        assert.deepStrictEqual(parseCustomFieldName('Account.Name'), {
            parentObject: 'Account',
            fieldApiName: 'Name',
            canonicalName: 'Account.Name'
        });
    });

    runTest('parseCustomFieldName rejects invalid identities', () => {
        assert.strictEqual(parseCustomFieldName('Name'), null);
        assert.strictEqual(parseCustomFieldName('A.B.C'), null);
        assert.strictEqual(parseCustomFieldName(null), null);
    });

    runTest('mapDescribeFieldToAttributes maps deterministic describe flags', () => {
        const attributes = mapDescribeFieldToAttributes({
            name: 'Amount__c',
            type: 'currency',
            length: 0,
            precision: 18,
            scale: 2,
            nillable: false,
            unique: false,
            externalId: false,
            referenceTo: [],
            label: 'Amount',
            calculated: false,
            custom: true
        });

        assert.strictEqual(attributes.type, 'currency');
        assert.strictEqual(attributes.precision, 18);
        assert.strictEqual(attributes.scale, 2);
        assert.strictEqual(attributes.required, true);
        assert.strictEqual(attributes.unique, false);
        assert.strictEqual(attributes.externalId, false);
        assert.deepStrictEqual(attributes.referenceTo, []);
        assert.strictEqual(attributes.picklistValues, null);
    });

    runTest(
        'mapDescribeFieldToAttributes includes picklist values when present',
        () => {
            const attributes = mapDescribeFieldToAttributes({
                name: 'Status__c',
                type: 'picklist',
                length: 255,
                precision: 0,
                scale: 0,
                nillable: true,
                unique: false,
                externalId: false,
                referenceTo: [],
                picklistValues: [
                    {
                        value: 'Open',
                        label: 'Open',
                        active: true,
                        defaultValue: true
                    }
                ],
                label: 'Status',
                calculated: false,
                custom: true
            });

            assert.strictEqual(attributes.required, false);
            assert.strictEqual(attributes.picklistValues.length, 1);
            assert.strictEqual(attributes.picklistValues[0].value, 'Open');
        }
    );

    runTest('mapDescribeFieldToAttributes maps referenceTo', () => {
        const attributes = mapDescribeFieldToAttributes({
            name: 'Account__c',
            type: 'reference',
            length: 18,
            precision: 0,
            scale: 0,
            nillable: true,
            unique: false,
            externalId: false,
            referenceTo: ['Account'],
            label: 'Account',
            calculated: false,
            custom: true
        });

        assert.deepStrictEqual(attributes.referenceTo, ['Account']);
    });

    await runAsyncTest(
        'buildDestinationShapeIndex without credentials marks unknown',
        async () => {
            const index = await buildDestinationShapeIndex({
                items: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Name'
                    },
                    { metadataType: 'ApexClass', metadataName: 'Foo' }
                ],
                accessToken: null,
                instanceUrl: null
            });

            assert.strictEqual(index.shapes.size, 1);
            const entry = getShapeEntry(index, 'CustomField', 'Account.Name');
            assert.ok(entry);
            assert.strictEqual(entry.queried, false);
            assert.strictEqual(entry.found, false);
            assert.ok(/credentials/i.test(entry.warning));
        }
    );

    await runAsyncTest(
        'buildDestinationShapeIndex ignores non-CustomField items',
        async () => {
            const index = await buildDestinationShapeIndex({
                items: [
                    { metadataType: 'CustomObject', metadataName: 'Account' }
                ],
                accessToken: null,
                instanceUrl: null
            });

            assert.strictEqual(index.shapes.size, 0);
            assert.strictEqual(index.summary.requested, 0);
        }
    );

    runTest('serializeDestinationShapeIndex nests by type and name', () => {
        const index = createEmptyDestinationShapeIndex();
        index.shapes.set(buildShapeKey('CustomField', 'Account.Name'), {
            metadataType: 'CustomField',
            metadataName: 'Account.Name',
            found: true,
            attributes: { type: 'string' }
        });
        index.summary.requested = 1;
        index.summary.resolved = 1;

        const serialized = serializeDestinationShapeIndex(index);

        assert.strictEqual(
            serialized.byType.CustomField['Account.Name'].attributes.type,
            'string'
        );
        assert.strictEqual(serialized.summary.resolved, 1);
    });

    if (!process.exitCode) {
        console.log('Phase 9B regression: PASS');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
