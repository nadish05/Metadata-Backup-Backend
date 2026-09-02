const assert = require('assert');

const customObjectRelationshipDiscoverer = require('../discoverers/customObjectRelationship.discoverer');
const customObjectGraphDiscoverer = require('./discoverers/customObject.graphDiscoverer');
const flexiPageGraphDiscoverer = require('./discoverers/flexiPage.graphDiscoverer');
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

function subscriptionMasterDetailParentMetadata(overrides = {}) {
    return {
        metadataType: 'CustomObject',
        metadataName: 'Subscription__c',
        name: 'Subscription__c',
        filePath: SUBSCRIPTION_OBJECT_PATH,
        origin: METADATA_ORIGINS.RELATIONSHIP_TARGET,
        discoveryMethod:
            customObjectRelationshipDiscoverer.STRUCTURAL_MASTER_DETAIL_PARENT_DISCOVERY_METHOD,
        sourceMetadata: 'Payment__c',
        sourceField: 'Subscription__c',
        ...overrides
    };
}

async function discoverSubscriptionMasterDetailParent(overrides = {}) {
    return customObjectGraphDiscoverer.discover({
        metadata: subscriptionMasterDetailParentMetadata(overrides),
        repoFiles: REPO_FILES,
        readRepoFile,
        listRepoFiles,
        depth: 3
    });
}

async function main() {
    await runTest(
        'TEST 1: structuralMasterDetailParent Subscription__c discovers Subscription_Record_Page',
        async () => {
            const result = await discoverSubscriptionMasterDetailParent();

            assert.deepStrictEqual(nodeNames(result, 'FlexiPage'), [
                'Subscription_Record_Page'
            ]);

            const flexiPage = findNode(
                result,
                'FlexiPage',
                'Subscription_Record_Page'
            );

            assert.ok(flexiPage);
            assert.strictEqual(flexiPage.relationship, 'ActionOverride');
            assert.strictEqual(flexiPage.discoveryMethod, 'actionOverrides');
            assert.strictEqual(flexiPage.sourceMetadata, 'Subscription__c');
        }
    );

    await runTest(
        'TEST 2: structuralMasterDetailParent Subscription__c excludes mismatched Account_Related_Record_1',
        async () => {
            const subscriptionWithMismatchedOverride = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Subscription</label>
    <sharingModel>ControlledByParent</sharingModel>
    <externalSharingModel>ControlledByParent</externalSharingModel>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Account_Related_Record_1</content>
    </actionOverrides>
</CustomObject>`;

            const result = await customObjectGraphDiscoverer.discover({
                metadata: subscriptionMasterDetailParentMetadata(),
                repoFiles: REPO_FILES,
                readRepoFile: createReadRepoFile({
                    [SUBSCRIPTION_OBJECT_PATH]: subscriptionWithMismatchedOverride
                }),
                listRepoFiles,
                depth: 3
            });

            assert.deepStrictEqual(nodeNames(result, 'FlexiPage'), []);
        }
    );

    await runTest(
        'TEST 3: structuralMasterDetailParent Subscription__c does not discover fields or additional parents',
        async () => {
            const result = await discoverSubscriptionMasterDetailParent();

            assert.deepStrictEqual(nodeNames(result, 'CustomField'), []);
            assert.deepStrictEqual(nodeNames(result, 'CustomObject'), []);
        }
    );

    await runTest(
        'TEST 4: structuralMasterDetailParent Subscription__c emits only ActionOverride FlexiPages',
        async () => {
            const result = await discoverSubscriptionMasterDetailParent();

            assert.strictEqual((result.discoveredNodes || []).length, 1);
            assert.strictEqual(
                result.discoveredNodes[0].metadataType,
                'FlexiPage'
            );
            assert.strictEqual(
                result.discoveredNodes[0].relationship,
                'ActionOverride'
            );
        }
    );

    await runTest(
        'TEST 5: FlexiPage expansion guard blocks Subscription_Record_Page child expansion',
        async () => {
            const subscriptionResult = await discoverSubscriptionMasterDetailParent();
            const flexiPageNode = findNode(
                subscriptionResult,
                'FlexiPage',
                'Subscription_Record_Page'
            );

            assert.ok(flexiPageNode);

            const flexiPageResult = await flexiPageGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'FlexiPage',
                    metadataName: 'Subscription_Record_Page',
                    name: 'Subscription_Record_Page',
                    filePath: SUBSCRIPTION_RECORD_PAGE_PATH,
                    origin: METADATA_ORIGINS.DIRECT_DEPENDENCY,
                    relationship: 'ActionOverride',
                    discoveryMethod: 'actionOverrides',
                    sourceMetadata: 'Subscription__c'
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                depth: 4
            });

            assert.deepStrictEqual(nodeNames(flexiPageResult, 'CustomField'), []);
            assert.deepStrictEqual(
                nodeNames(flexiPageResult, 'LightningComponentBundle'),
                []
            );
            assert.deepStrictEqual(nodeNames(flexiPageResult, 'ApexClass'), []);
        }
    );

    await runTest(
        'TEST 6: FIX #2A ParentObject Account still skips Account_Related_Record_1',
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
        'TEST 7: FIX #2B Payment__c.Subscription__c still emits Subscription__c parent',
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
        }
    );

    await runTest(
        'TEST 8: RelatedListParentObject Payment__c still discovers Payment_Record_Page',
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
        'TEST 9: PRIMARY CustomObject Payment__c remains unchanged',
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
        'TEST 10: normal RELATIONSHIP_TARGET Member__c retains structural FlexiPage behavior',
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
        'TEST 11: Layout integration package includes Subscription_Record_Page without unrelated expansion',
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

            const subscriptionGraphResult =
                await discoverSubscriptionMasterDetailParent();

            const graphDependencies = [
                ...(paymentGraphResult.discoveredNodes || []),
                ...(subscriptionGraphResult.discoveredNodes || [])
            ].map((node) => ({
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
                    ['FlexiPage:Payment_Record_Page', 'MISSING'],
                    ['FlexiPage:Subscription_Record_Page', 'MISSING']
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
            assert.ok(packageFlexiPages.includes('Subscription_Record_Page'));
            assert.strictEqual(
                packageFlexiPages.includes('Account_Related_Record_1'),
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
            assert.strictEqual(
                getPackageMemberNames(
                    generatedPackage,
                    'LightningComponentBundle'
                ).includes('refundPayment'),
                false
            );
            assert.strictEqual(
                getPackageMemberNames(generatedPackage, 'ApexClass').includes(
                    'PaymentRefundController'
                ),
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
