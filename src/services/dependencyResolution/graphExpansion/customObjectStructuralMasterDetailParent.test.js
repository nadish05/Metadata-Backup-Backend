const assert = require('assert');

const customObjectRelationshipDiscoverer = require('../discoverers/customObjectRelationship.discoverer');
const customObjectGraphDiscoverer = require('./discoverers/customObject.graphDiscoverer');
const layoutReferenceDiscoverer = require('../discoverers/layoutReference.discoverer');
const {
    mergeDeployableReferences,
    resolveDependencies
} = require('../dependencyResolution.service');
const { generateDeploymentPackage } = require('../../deploymentPackage.service');
const {
    METADATA_ORIGINS
} = require('../metadataGraphOrigin.model');

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
const PAYMENT_SUBSCRIPTION_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Subscription__c.field-meta.xml';
const PAYMENT_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Payment_Record_Page.flexipage-meta.xml';
const SUBSCRIPTION_OBJECT_PATH =
    'force-app/main/default/objects/Subscription__c/Subscription__c.object-meta.xml';
const SUBSCRIPTION_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Subscription_Record_Page.flexipage-meta.xml';
const SUBSCRIPTION_PLAN_FIELD_PATH =
    'force-app/main/default/objects/Subscription__c/fields/Plan__c.field-meta.xml';
const SUBSCRIPTION_PARENT_MD_FIELD_PATH =
    'force-app/main/default/objects/Subscription__c/fields/Account__c.field-meta.xml';
const ACCOUNT_OBJECT_PATH =
    'force-app/main/default/objects/Account/Account.object-meta.xml';
const ACCOUNT_RELATED_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Account_Related_Record_1.flexipage-meta.xml';
const MEMBER_OBJECT_PATH =
    'force-app/main/default/objects/Member__c/Member__c.object-meta.xml';
const MEMBER_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Member_Record_Page.flexipage-meta.xml';

const PAYMENT_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Payment</label>
    <sharingModel>ControlledByParent</sharingModel>
    <externalSharingModel>ControlledByParent</externalSharingModel>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Payment_Record_Page</content>
    </actionOverrides>
</CustomObject>`;

const PAYMENT_SUBSCRIPTION_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Subscription__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Subscription__c</referenceTo>
    <relationshipName>Payments</relationshipName>
</CustomField>`;

const PAYMENT_ACCOUNT_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
</CustomField>`;

const PAYMENT_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Payment__c</sobjectType>
    <masterLabel>Payment Record Page</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

const SUBSCRIPTION_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Subscription</label>
    <sharingModel>ControlledByParent</sharingModel>
    <externalSharingModel>ControlledByParent</externalSharingModel>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Subscription_Record_Page</content>
    </actionOverrides>
</CustomObject>`;

const SUBSCRIPTION_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Subscription__c</sobjectType>
    <masterLabel>Subscription Record Page</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

const SUBSCRIPTION_PLAN_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Plan__c</fullName>
    <type>Text</type>
    <length>80</length>
</CustomField>`;

const SUBSCRIPTION_PARENT_MD_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Account</referenceTo>
</CustomField>`;

const ACCOUNT_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Account</label>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Account_Related_Record_1</content>
    </actionOverrides>
</CustomObject>`;

const ACCOUNT_RELATED_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Account</sobjectType>
    <masterLabel>Account Related Record 1</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

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

const MEMBER_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Member__c</sobjectType>
    <masterLabel>Member Record Page</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

const FILE_CONTENT = {
    [PAYMENT_OBJECT_PATH]: PAYMENT_OBJECT_XML,
    [PAYMENT_ACCOUNT_FIELD_PATH]: PAYMENT_ACCOUNT_FIELD_XML,
    [PAYMENT_SUBSCRIPTION_FIELD_PATH]: PAYMENT_SUBSCRIPTION_FIELD_XML,
    [PAYMENT_RECORD_PAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
    [SUBSCRIPTION_OBJECT_PATH]: SUBSCRIPTION_OBJECT_XML,
    [SUBSCRIPTION_RECORD_PAGE_PATH]: SUBSCRIPTION_RECORD_PAGE_XML,
    [SUBSCRIPTION_PLAN_FIELD_PATH]: SUBSCRIPTION_PLAN_FIELD_XML,
    [SUBSCRIPTION_PARENT_MD_FIELD_PATH]: SUBSCRIPTION_PARENT_MD_FIELD_XML,
    [ACCOUNT_OBJECT_PATH]: ACCOUNT_OBJECT_XML,
    [ACCOUNT_RELATED_RECORD_PAGE_PATH]: ACCOUNT_RELATED_RECORD_PAGE_XML,
    [MEMBER_OBJECT_PATH]: MEMBER_OBJECT_XML,
    [MEMBER_RECORD_PAGE_PATH]: MEMBER_RECORD_PAGE_XML
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

const readRepoFile = createReadRepoFile();

async function listRepoFiles() {
    return REPO_FILES;
}

function nodeNames(result, metadataType) {
    return (result.discoveredNodes || [])
        .filter((node) => node.metadataType === metadataType)
        .map((node) => node.name);
}

function findNode(result, metadataType, name) {
    return (result.discoveredNodes || []).find(
        (node) => node.metadataType === metadataType && node.name === name
    );
}

function getPackageMemberNames(generatedPackage, metadataType) {
    return (generatedPackage?.metadata || [])
        .filter((item) => item.metadataType === metadataType)
        .map((item) => item.metadataName);
}

async function main() {
    await runTest(
        'TEST 1: ControlledByParent Payment__c.Subscription__c emits field and parent CustomObject',
        async () => {
            const relationships =
                await customObjectRelationshipDiscoverer.discoverControlledByParentMasterDetailOwningFields(
                    {
                        objectApiName: 'Payment__c',
                        objectXml: PAYMENT_OBJECT_XML,
                        repoFiles: REPO_FILES,
                        readRepoFile,
                        depth: 2
                    }
                );

            const names = relationships.map((item) => item.name).sort();

            assert.deepStrictEqual(names, [
                'Payment__c.Subscription__c',
                'Subscription__c'
            ]);
            assert.ok(
                relationships.some(
                    (item) =>
                        item.name === 'Payment__c.Subscription__c' &&
                        item.metadataType === 'CustomField'
                )
            );
            assert.ok(
                relationships.some(
                    (item) =>
                        item.name === 'Subscription__c' &&
                        item.metadataType === 'CustomObject'
                )
            );
        }
    );

    await runTest(
        'TEST 2: structural MasterDetail parent carries expected metadata',
        async () => {
            const relationships =
                await customObjectRelationshipDiscoverer.discoverControlledByParentMasterDetailOwningFields(
                    {
                        objectApiName: 'Payment__c',
                        objectXml: PAYMENT_OBJECT_XML,
                        repoFiles: REPO_FILES,
                        readRepoFile,
                        depth: 2
                    }
                );

            const parent = relationships.find(
                (item) => item.name === 'Subscription__c'
            );

            assert.ok(parent);
            assert.strictEqual(parent.relationship, 'MasterDetail');
            assert.strictEqual(parent.origin, METADATA_ORIGINS.RELATIONSHIP_TARGET);
            assert.strictEqual(
                parent.discoveryMethod,
                customObjectRelationshipDiscoverer.STRUCTURAL_MASTER_DETAIL_PARENT_DISCOVERY_METHOD
            );
            assert.strictEqual(
                parent.discoveredBy,
                'CustomObjectRelationshipDiscoverer'
            );
            assert.strictEqual(parent.sourceMetadata, 'Payment__c');
            assert.strictEqual(parent.sourceField, 'Subscription__c');
        }
    );

    await runTest(
        'TEST 3: structuralMasterDetailParent Subscription__c does not expand',
        async () => {
            const paymentResult = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY,
                    referenceType: 'RelatedListParentObject',
                    relationship: 'RelatedListParentObject',
                    discoveryMethod: 'layoutReference',
                    sourceMetadata: 'Account-Gym Member Layout'
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles,
                depth: 2
            });

            const subscriptionNode = findNode(
                paymentResult,
                'CustomObject',
                'Subscription__c'
            );

            assert.ok(subscriptionNode);
            assert.strictEqual(
                subscriptionNode.discoveryMethod,
                customObjectRelationshipDiscoverer.STRUCTURAL_MASTER_DETAIL_PARENT_DISCOVERY_METHOD
            );

            const terminalResult = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Subscription__c',
                    name: 'Subscription__c',
                    filePath: SUBSCRIPTION_OBJECT_PATH,
                    origin: METADATA_ORIGINS.RELATIONSHIP_TARGET,
                    discoveryMethod:
                        customObjectRelationshipDiscoverer.STRUCTURAL_MASTER_DETAIL_PARENT_DISCOVERY_METHOD,
                    sourceMetadata: 'Payment__c',
                    sourceField: 'Subscription__c'
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles,
                depth: 3
            });

            assert.deepStrictEqual(nodeNames(terminalResult, 'FlexiPage'), []);
            assert.deepStrictEqual(nodeNames(terminalResult, 'CustomField'), []);
            assert.deepStrictEqual(nodeNames(terminalResult, 'CustomObject'), []);
        }
    );

    await runTest(
        'TEST 4: Payment_Record_Page structural behavior remains unchanged',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY,
                    referenceType: 'RelatedListParentObject',
                    relationship: 'RelatedListParentObject',
                    discoveryMethod: 'layoutReference',
                    sourceMetadata: 'Account-Gym Member Layout'
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
        }
    );

    await runTest(
        'TEST 5: FIX #2A ParentObject Account still skips Account_Related_Record_1',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Account',
                    name: 'Account',
                    filePath: ACCOUNT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY,
                    referenceType: 'ParentObject',
                    relationship: 'ParentObject',
                    discoveryMethod: 'layoutReference',
                    sourceMetadata: 'Account-Gym Member Layout'
                },
                repoFiles: [
                    ACCOUNT_OBJECT_PATH,
                    ACCOUNT_RELATED_RECORD_PAGE_PATH
                ],
                readRepoFile,
                listRepoFiles: async () => [
                    ACCOUNT_OBJECT_PATH,
                    ACCOUNT_RELATED_RECORD_PAGE_PATH
                ],
                depth: 2
            });

            assert.deepStrictEqual(nodeNames(result, 'FlexiPage'), []);
        }
    );

    await runTest(
        'TEST 6: PRIMARY Payment__c still receives full discovery',
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
                nodeNames(result, 'FlexiPage').includes('Payment_Record_Page')
            );
            assert.ok(result.statistics.reviewsExecuted >= 1);
        }
    );

    await runTest(
        'TEST 7: normal RELATIONSHIP_TARGET Member__c retains structural FlexiPage behavior',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Member__c',
                    name: 'Member__c',
                    filePath: MEMBER_OBJECT_PATH,
                    origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
                },
                repoFiles: [MEMBER_OBJECT_PATH, MEMBER_RECORD_PAGE_PATH],
                readRepoFile: createReadRepoFile(),
                listRepoFiles: async () => [
                    MEMBER_OBJECT_PATH,
                    MEMBER_RECORD_PAGE_PATH
                ],
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
        'TEST 8: Layout integration package includes Subscription__c shell without unrelated expansion',
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

            const paymentGraphResult = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY,
                    referenceType: 'RelatedListParentObject',
                    relationship: 'RelatedListParentObject',
                    discoveryMethod: 'layoutReference',
                    sourceMetadata: 'Account-Gym Member Layout'
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles,
                depth: 2
            });

            const graphDependencies = (
                paymentGraphResult.discoveredNodes || []
            ).map((node) => ({
                name: node.name,
                type: node.metadataType,
                metadataType: node.metadataType,
                relationship: node.relationship || null,
                action: 'DEPLOY',
                required: true,
                selected: true
            }));

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
                    ['CustomObject:Subscription__c', 'MISSING'],
                    ['CustomField:Payment__c.Account__c', 'MISSING'],
                    ['CustomField:Payment__c.Subscription__c', 'MISSING'],
                    ['FlexiPage:Payment_Record_Page', 'MISSING']
                ])
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
            const packageLayouts = getPackageMemberNames(
                generatedPackage,
                'Layout'
            );

            assert.ok(packageLayouts.includes('Account-Gym Member Layout'));
            assert.ok(packageObjects.includes('Payment__c'));
            assert.ok(packageObjects.includes('Subscription__c'));
            assert.ok(packageFields.includes('Payment__c.Account__c'));
            assert.ok(packageFields.includes('Payment__c.Subscription__c'));
            assert.ok(packageFlexiPages.includes('Payment_Record_Page'));
            assert.strictEqual(
                packageFlexiPages.includes('Account_Related_Record_1'),
                false
            );
            assert.strictEqual(
                packageFlexiPages.includes('Subscription_Record_Page'),
                false
            );
            assert.strictEqual(
                packageFields.includes('Subscription__c.Plan__c'),
                false
            );
            assert.strictEqual(
                packageFields.includes('Subscription__c.Account__c'),
                false
            );
            assert.strictEqual(
                packageObjects.includes('Member__c'),
                false
            );
        }
    );

    if (process.exitCode) {
        console.error('customObjectStructuralMasterDetailParent.test.js FAILED');
    } else {
        console.log('customObjectStructuralMasterDetailParent.test.js PASSED');
    }
}

main();
