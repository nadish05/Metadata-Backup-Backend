const assert = require('assert');

const customObjectGraphDiscoverer = require('./customObject.graphDiscoverer');
const {
    METADATA_ORIGINS
} = require('../../metadataGraphOrigin.model');
const layoutReferenceDiscoverer = require('../../discoverers/layoutReference.discoverer');
const permissionSetRelationshipDiscoverer = require('../../discoverers/permissionSetRelationship.discoverer');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

const PAYMENT_OBJECT_PATH =
    'force-app/main/default/objects/Payment__c/Payment__c.object-meta.xml';
const PAYMENT_ACCOUNT_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml';
const PAYMENT_MEMBER_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Member__c.field-meta.xml';
const PAYMENT_AMOUNT_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Amount_Due__c.field-meta.xml';
const MEMBER_OBJECT_PATH =
    'force-app/main/default/objects/Member__c/Member__c.object-meta.xml';

const PAYMENT_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Payment</label>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Payment_Record_Page</content>
    </actionOverrides>
</CustomObject>`;

const PAYMENT_ACCOUNT_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
</CustomField>`;

const PAYMENT_MEMBER_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Member__c</fullName>
    <type>Lookup</type>
    <referenceTo>Member__c</referenceTo>
</CustomField>`;

const PAYMENT_AMOUNT_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Amount_Due__c</fullName>
    <type>Currency</type>
</CustomField>`;

const MEMBER_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Member</label>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Member_Record_Page</content>
    </actionOverrides>
</CustomObject>`;

const REPO_FILES = [
    PAYMENT_OBJECT_PATH,
    PAYMENT_ACCOUNT_FIELD_PATH,
    PAYMENT_MEMBER_FIELD_PATH,
    PAYMENT_AMOUNT_FIELD_PATH,
    MEMBER_OBJECT_PATH
];

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    if (normalized === PAYMENT_OBJECT_PATH) {
        return PAYMENT_OBJECT_XML;
    }

    if (normalized === PAYMENT_ACCOUNT_FIELD_PATH) {
        return PAYMENT_ACCOUNT_FIELD_XML;
    }

    if (normalized === PAYMENT_MEMBER_FIELD_PATH) {
        return PAYMENT_MEMBER_FIELD_XML;
    }

    if (normalized === PAYMENT_AMOUNT_FIELD_PATH) {
        return PAYMENT_AMOUNT_FIELD_XML;
    }

    if (normalized === MEMBER_OBJECT_PATH) {
        return MEMBER_OBJECT_XML;
    }

    throw new Error(`Unexpected read: ${filePath}`);
}

async function listRepoFiles() {
    return REPO_FILES;
}

function nodeNames(result, metadataType) {
    return (result.discoveredNodes || [])
        .filter((node) => node.metadataType === metadataType)
        .map((node) => node.name);
}

async function main() {
    await runTest(
        'TEST 1: secondary CustomObject does not broadly expand in graph discoverer',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles,
                depth: 2
            });

            assert.deepStrictEqual(result.discoveredNodes, []);
            assert.deepStrictEqual(result.discoveredEdges, []);
            assert.strictEqual(result.statistics.reviewsExecuted, 0);
        }
    );

    await runTest(
        'TEST 2: primary CustomObject still runs broad graph expansion',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.PRIMARY_SELECTION
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles,
                depth: 1
            });

            assert.ok(
                nodeNames(result, 'FlexiPage').includes('Payment_Record_Page'),
                'expected actionOverride FlexiPage from primary Payment__c scan'
            );
            assert.ok(
                nodeNames(result, 'CustomObject').includes('Member__c'),
                'expected lookup target Member__c from primary Payment__c scan'
            );
            assert.ok(
                nodeNames(result, 'CustomField').includes(
                    'Payment__c.Amount_Due__c'
                ),
                'expected Payment__c.Amount_Due__c from primary deployment review'
            );
            assert.ok(result.statistics.reviewsExecuted >= 1);
        }
    );

    await runTest(
        'TEST 3: Layout related-list parent CustomObject stays in references without graph neighborhood expansion',
        async () => {
            const layoutXml = `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <relatedLists>
        <fields>NAME</fields>
        <relatedList>Payment__c.Account__c</relatedList>
    </relatedLists>
</Layout>`;

            const layoutDiscovery = await layoutReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: 'Account-Gym Member Layout',
                        filePath:
                            'force-app/main/default/layouts/Account-Gym Member Layout.layout-meta.xml'
                    }
                ],
                repoFiles: [
                    'force-app/main/default/layouts/Account-Gym Member Layout.layout-meta.xml'
                ],
                readRepoFile: async () => layoutXml,
                depth: 1
            });

            const refs = layoutDiscovery.references || [];
            assert.ok(
                refs.some(
                    (ref) =>
                        ref.metadataType === 'CustomObject' &&
                        ref.name === 'Payment__c'
                )
            );
            assert.ok(
                refs.some(
                    (ref) =>
                        ref.metadataType === 'CustomField' &&
                        ref.name === 'Payment__c.Account__c'
                )
            );

            const graphResult = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles,
                depth: 2
            });

            assert.deepStrictEqual(graphResult.discoveredNodes, []);
            assert.strictEqual(
                nodeNames(graphResult, 'FlexiPage').length,
                0,
                'Layout secondary Payment__c must not discover FlexiPages'
            );
        }
    );

    await runTest(
        'TEST 4: relationship-target recursive CustomObject visit does not re-expand',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Member__c',
                    name: 'Member__c',
                    filePath: MEMBER_OBJECT_PATH,
                    origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles,
                depth: 3
            });

            assert.deepStrictEqual(result.discoveredNodes, []);
            assert.strictEqual(
                nodeNames(result, 'FlexiPage').length,
                0,
                'relationship-target Member__c must not discover Member_Record_Page'
            );
        }
    );

    await runTest(
        'TEST 5: PermissionSet relationship discovery path is separate from graph discoverer',
        async () => {
            const result = await permissionSetRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'PermissionSet',
                        metadataName: 'Subscription_Access',
                        filePath:
                            'force-app/main/default/permissionsets/Subscription_Access.permissionset-meta.xml'
                    }
                ],
                repoFiles: [
                    'force-app/main/default/permissionsets/Subscription_Access.permissionset-meta.xml'
                ],
                readRepoFile: async () => `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldPermissions>
        <field>Payment__c.Amount_Due__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
</PermissionSet>`,
                depth: 1
            });

            const objectNames = (result.relationships || [])
                .filter((item) => item.metadataType === 'CustomObject')
                .map((item) => item.name);
            const fieldNames = (result.relationships || [])
                .filter((item) => item.metadataType === 'CustomField')
                .map((item) => item.name);

            assert.deepStrictEqual(objectNames, ['Payment__c']);
            assert.deepStrictEqual(fieldNames, ['Payment__c.Amount_Due__c']);
        }
    );
}

main();
