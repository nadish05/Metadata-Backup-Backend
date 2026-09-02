const assert = require('assert');

const customObjectGraphDiscoverer = require('./customObject.graphDiscoverer');
const {
    METADATA_ORIGINS
} = require('../../metadataGraphOrigin.model');
const layoutReferenceDiscoverer = require('../../discoverers/layoutReference.discoverer');
const permissionSetRelationshipDiscoverer = require('../../discoverers/permissionSetRelationship.discoverer');
const {
    mergeDeployableReferences,
    resolveDependencies
} = require('../../dependencyResolution.service');
const { generateDeploymentPackage } = require('../../../deploymentPackage.service');

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
const PAYMENT_PARENT_LINK_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Parent_Link__c.field-meta.xml';
const MEMBER_OBJECT_PATH =
    'force-app/main/default/objects/Member__c/Member__c.object-meta.xml';
const READWRITE_OBJECT_PATH =
    'force-app/main/default/objects/ReadWrite__c/ReadWrite__c.object-meta.xml';
const READWRITE_LOOKUP_FIELD_PATH =
    'force-app/main/default/objects/ReadWrite__c/fields/Coordinator__c.field-meta.xml';

function buildPaymentObjectXml({ controlledByParent = false } = {}) {
    const sharingXml = controlledByParent
        ? `
    <sharingModel>ControlledByParent</sharingModel>
    <externalSharingModel>ControlledByParent</externalSharingModel>`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Payment</label>${sharingXml}
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Payment_Record_Page</content>
    </actionOverrides>
</CustomObject>`;
}

const PAYMENT_OBJECT_XML = buildPaymentObjectXml();
const PAYMENT_OBJECT_CONTROLLED_XML = buildPaymentObjectXml({
    controlledByParent: true
});

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

const PAYMENT_PARENT_LINK_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Parent_Link__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Member__c</referenceTo>
    <relationshipName>Payments</relationshipName>
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

const READWRITE_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Read Write</label>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;

const READWRITE_LOOKUP_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Coordinator__c</fullName>
    <type>Lookup</type>
    <referenceTo>Employee__c</referenceTo>
</CustomField>`;

const FILE_CONTENT = {
    [PAYMENT_OBJECT_PATH]: PAYMENT_OBJECT_XML,
    [PAYMENT_ACCOUNT_FIELD_PATH]: PAYMENT_ACCOUNT_FIELD_XML,
    [PAYMENT_MEMBER_FIELD_PATH]: PAYMENT_MEMBER_FIELD_XML,
    [PAYMENT_AMOUNT_FIELD_PATH]: PAYMENT_AMOUNT_FIELD_XML,
    [PAYMENT_PARENT_LINK_FIELD_PATH]: PAYMENT_PARENT_LINK_FIELD_XML,
    [MEMBER_OBJECT_PATH]: MEMBER_OBJECT_XML,
    [READWRITE_OBJECT_PATH]: READWRITE_OBJECT_XML,
    [READWRITE_LOOKUP_FIELD_PATH]: READWRITE_LOOKUP_FIELD_XML
};

const REPO_FILES = Object.keys(FILE_CONTENT);

function createReadRepoFile(overrides = {}) {
    return async function readRepoFile(filePath) {
        const normalized = String(filePath).replace(/\\/g, '/');

        if (overrides[normalized] != null) {
            return overrides[normalized];
        }

        if (FILE_CONTENT[normalized] != null) {
            return FILE_CONTENT[normalized];
        }

        throw new Error(`Unexpected read: ${filePath}`);
    };
}

const readRepoFile = createReadRepoFile({
    [PAYMENT_OBJECT_PATH]: PAYMENT_OBJECT_CONTROLLED_XML
});

async function listRepoFiles() {
    return REPO_FILES;
}

function nodeNames(result, metadataType) {
    return (result.discoveredNodes || [])
        .filter((node) => node.metadataType === metadataType)
        .map((node) => node.name);
}

function getPackageMemberNames(generatedPackage, metadataType) {
    return (generatedPackage?.metadata || [])
        .filter((item) => item.metadataType === metadataType)
        .map((item) => item.metadataName);
}

async function main() {
    await runTest(
        'TEST 1: secondary CustomObject emits structural FlexiPage without broad expansion',
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

            assert.ok(
                nodeNames(result, 'FlexiPage').includes('Payment_Record_Page')
            );
            assert.strictEqual(
                nodeNames(result, 'CustomObject').includes('Member__c'),
                false
            );
            assert.strictEqual(
                nodeNames(result, 'CustomField').includes(
                    'Payment__c.Amount_Due__c'
                ),
                false
            );
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
        'TEST 3: secondary ControlledByParent emits MasterDetail field only',
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

            assert.ok(
                nodeNames(result, 'CustomField').includes(
                    'Payment__c.Parent_Link__c'
                )
            );
            assert.strictEqual(
                nodeNames(result, 'CustomField').includes(
                    'Payment__c.Account__c'
                ),
                false
            );
            assert.strictEqual(
                nodeNames(result, 'CustomField').includes(
                    'Payment__c.Amount_Due__c'
                ),
                false
            );
            assert.strictEqual(
                nodeNames(result, 'CustomObject').includes('Member__c'),
                false
            );
        }
    );

    await runTest(
        'TEST 4: secondary Payment__c emits structural FlexiPage and MasterDetail only',
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

            assert.deepStrictEqual(
                nodeNames(result, 'FlexiPage').sort(),
                ['Payment_Record_Page']
            );
            assert.deepStrictEqual(nodeNames(result, 'CustomField').sort(), [
                'Payment__c.Parent_Link__c'
            ]);
            assert.deepStrictEqual(nodeNames(result, 'CustomObject'), []);
        }
    );

    await runTest(
        'TEST 5: secondary CustomObject without ControlledByParent skips MasterDetail scan',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'ReadWrite__c',
                    name: 'ReadWrite__c',
                    filePath: READWRITE_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY
                },
                repoFiles: REPO_FILES,
                readRepoFile: createReadRepoFile(),
                listRepoFiles,
                depth: 2
            });

            assert.deepStrictEqual(nodeNames(result, 'CustomField'), []);
            assert.deepStrictEqual(nodeNames(result, 'CustomObject'), []);
            assert.deepStrictEqual(nodeNames(result, 'FlexiPage'), []);
        }
    );

    await runTest(
        'TEST 6: relationship-target CustomObject emits structural FlexiPage only',
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
                readRepoFile: createReadRepoFile(),
                listRepoFiles,
                depth: 3
            });

            assert.deepStrictEqual(
                nodeNames(result, 'FlexiPage').sort(),
                ['Member_Record_Page']
            );
            assert.deepStrictEqual(nodeNames(result, 'CustomField'), []);
            assert.deepStrictEqual(nodeNames(result, 'CustomObject'), []);
        }
    );

    await runTest(
        'TEST 7: Layout related-list Payment__c structural dependencies merge into package',
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

            const graphDependencies = (graphResult.discoveredNodes || []).map(
                (node) => ({
                    name: node.name,
                    type: node.metadataType,
                    metadataType: node.metadataType,
                    action: 'DEPLOY',
                    required: true,
                    selected: true
                })
            );

            const mergedDependencies = mergeDeployableReferences(
                [],
                [
                    ...(layoutDiscovery.references || []),
                    ...graphDependencies.map((dependency) => ({
                        ...dependency,
                        deployable: true,
                        blocking: true
                    }))
                ]
            );

            const resolution = await resolveDependencies({
                requiredDependencies: mergedDependencies,
                discoveredReferences: layoutDiscovery.references || [],
                destinationStates: new Map([
                    ['CustomObject:Account', 'EXISTS'],
                    ['CustomObject:Payment__c', 'MISSING'],
                    ['CustomField:Payment__c.Account__c', 'MISSING'],
                    ['CustomField:Payment__c.Parent_Link__c', 'MISSING'],
                    ['FlexiPage:Payment_Record_Page', 'MISSING']
                ]),
                artifactFlags: {
                    'CustomObject:Payment__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomField:Payment__c.Account__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomField:Payment__c.Parent_Link__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'FlexiPage:Payment_Record_Page': {
                        artifactResolved: true,
                        sourceExists: true
                    }
                }
            });

            const generatedPackage = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: 'Account-Gym Member Layout'
                    }
                ],
                requiredDependencies: resolution.resolvedDependencies,
                selectedTestClasses: []
            });

            const packageObjects = getPackageMemberNames(
                generatedPackage,
                'CustomObject'
            );
            const packageFields = getPackageMemberNames(
                generatedPackage,
                'CustomField'
            );
            const packageFlexiPages = getPackageMemberNames(
                generatedPackage,
                'FlexiPage'
            );

            assert.ok(packageObjects.includes('Payment__c'));
            assert.ok(packageFields.includes('Payment__c.Account__c'));
            assert.ok(packageFields.includes('Payment__c.Parent_Link__c'));
            assert.ok(packageFlexiPages.includes('Payment_Record_Page'));
            assert.strictEqual(packageObjects.includes('Member__c'), false);
            assert.strictEqual(
                packageFields.includes('Payment__c.Amount_Due__c'),
                false
            );
        }
    );

    await runTest(
        'TEST 8: PermissionSet relationship discovery path is separate from graph discoverer',
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
