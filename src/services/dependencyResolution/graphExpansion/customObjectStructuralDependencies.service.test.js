const assert = require('assert');

const {
    discoverStructuralCustomObjectDependencies
} = require('./customObjectStructuralDependencies.service');
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

const ACCOUNT_OBJECT_PATH =
    'force-app/main/default/objects/Account/Account.object-meta.xml';
const ACCOUNT_RELATED_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Account_Related_Record_1.flexipage-meta.xml';
const PAYMENT_OBJECT_PATH =
    'force-app/main/default/objects/Payment__c/Payment__c.object-meta.xml';
const PAYMENT_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Payment_Record_Page.flexipage-meta.xml';
const PAYMENT_PARENT_LINK_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Parent_Link__c.field-meta.xml';

function buildPaymentObjectXml({ includeAccountOverride = false } = {}) {
    const accountOverrideXml = includeAccountOverride
        ? `
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Account_Related_Record_1</content>
    </actionOverrides>`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Payment</label>
    <sharingModel>ControlledByParent</sharingModel>
    <externalSharingModel>ControlledByParent</externalSharingModel>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <formFactor>Large</formFactor>
        <content>Payment_Record_Page</content>
    </actionOverrides>${accountOverrideXml}
</CustomObject>`;
}

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

const PAYMENT_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Payment__c</sobjectType>
    <masterLabel>Payment Record Page</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

const ACCOUNT_RELATED_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Account</sobjectType>
    <masterLabel>Account Related Record 1</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

const PAYMENT_PARENT_LINK_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Parent_Link__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Member__c</referenceTo>
</CustomField>`;

function createReadRepoFile(overrides = {}) {
    return async function readRepoFile(filePath) {
        const normalized = String(filePath).replace(/\\/g, '/');

        if (overrides[normalized] != null) {
            return overrides[normalized];
        }

        throw new Error(`Unexpected read: ${filePath}`);
    };
}

function flexiPageNames(relationships) {
    return (relationships || [])
        .filter((relationship) => relationship.metadataType === 'FlexiPage')
        .map((relationship) => relationship.name);
}

function getPackageMemberNames(generatedPackage, metadataType) {
    return (generatedPackage?.metadata || [])
        .filter((item) => item.metadataType === metadataType)
        .map((item) => item.metadataName);
}

function layoutParentObjectScanTarget(objectApiName, filePath) {
    return {
        metadataType: 'CustomObject',
        metadataName: objectApiName,
        filePath,
        referenceType: 'ParentObject',
        relationship: 'ParentObject',
        discoveryMethod: 'layoutReference',
        sourceMetadata: 'Account-Gym Member Layout'
    };
}

function layoutRelatedListParentScanTarget(objectApiName, filePath) {
    return {
        metadataType: 'CustomObject',
        metadataName: objectApiName,
        filePath,
        referenceType: 'RelatedListParentObject',
        relationship: 'RelatedListParentObject',
        discoveryMethod: 'layoutReference',
        sourceMetadata: 'Account-Gym Member Layout'
    };
}

async function main() {
    await runTest(
        'TEST 1: RelatedListParentObject matching FlexiPage sobjectType is discovered',
        async () => {
            const repoFiles = [
                PAYMENT_OBJECT_PATH,
                PAYMENT_RECORD_PAGE_PATH,
                PAYMENT_PARENT_LINK_FIELD_PATH
            ];
            const result = await discoverStructuralCustomObjectDependencies({
                objectApiName: 'Payment__c',
                scanTarget: layoutRelatedListParentScanTarget(
                    'Payment__c',
                    PAYMENT_OBJECT_PATH
                ),
                repoFiles,
                readRepoFile: createReadRepoFile({
                    [PAYMENT_OBJECT_PATH]: buildPaymentObjectXml(),
                    [PAYMENT_RECORD_PAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
                    [PAYMENT_PARENT_LINK_FIELD_PATH]: PAYMENT_PARENT_LINK_FIELD_XML
                }),
                depth: 2
            });

            assert.deepStrictEqual(flexiPageNames(result.relationships), [
                'Payment_Record_Page'
            ]);
            assert.ok(
                result.relationships.some(
                    (relationship) =>
                        relationship.name === 'Payment__c.Parent_Link__c'
                )
            );
        }
    );

    await runTest(
        'TEST 2: mismatched FlexiPage sobjectType remains excluded from structural actionOverrides',
        async () => {
            const repoFiles = [
                PAYMENT_OBJECT_PATH,
                PAYMENT_RECORD_PAGE_PATH,
                ACCOUNT_RELATED_RECORD_PAGE_PATH,
                PAYMENT_PARENT_LINK_FIELD_PATH
            ];
            const result = await discoverStructuralCustomObjectDependencies({
                objectApiName: 'Payment__c',
                scanTarget: layoutRelatedListParentScanTarget(
                    'Payment__c',
                    PAYMENT_OBJECT_PATH
                ),
                repoFiles,
                readRepoFile: createReadRepoFile({
                    [PAYMENT_OBJECT_PATH]: buildPaymentObjectXml({
                        includeAccountOverride: true
                    }),
                    [PAYMENT_RECORD_PAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
                    [ACCOUNT_RELATED_RECORD_PAGE_PATH]:
                        ACCOUNT_RELATED_RECORD_PAGE_XML,
                    [PAYMENT_PARENT_LINK_FIELD_PATH]: PAYMENT_PARENT_LINK_FIELD_XML
                }),
                depth: 2
            });

            assert.deepStrictEqual(flexiPageNames(result.relationships), [
                'Payment_Record_Page'
            ]);
        }
    );

    await runTest(
        'TEST 3: ParentObject Account skips structural ActionOverride FlexiPages',
        async () => {
            const repoFiles = [
                ACCOUNT_OBJECT_PATH,
                ACCOUNT_RELATED_RECORD_PAGE_PATH
            ];
            const result = await discoverStructuralCustomObjectDependencies({
                objectApiName: 'Account',
                scanTarget: layoutParentObjectScanTarget(
                    'Account',
                    ACCOUNT_OBJECT_PATH
                ),
                repoFiles,
                readRepoFile: createReadRepoFile({
                    [ACCOUNT_OBJECT_PATH]: ACCOUNT_OBJECT_XML,
                    [ACCOUNT_RELATED_RECORD_PAGE_PATH]:
                        ACCOUNT_RELATED_RECORD_PAGE_XML
                }),
                depth: 2
            });

            assert.deepStrictEqual(flexiPageNames(result.relationships), []);
        }
    );

    await runTest(
        'TEST 4: ParentObject ingress still allows ControlledByParent MasterDetail discovery',
        async () => {
            const repoFiles = [
                PAYMENT_OBJECT_PATH,
                PAYMENT_RECORD_PAGE_PATH,
                PAYMENT_PARENT_LINK_FIELD_PATH
            ];
            const result = await discoverStructuralCustomObjectDependencies({
                objectApiName: 'Payment__c',
                scanTarget: layoutParentObjectScanTarget(
                    'Payment__c',
                    PAYMENT_OBJECT_PATH
                ),
                repoFiles,
                readRepoFile: createReadRepoFile({
                    [PAYMENT_OBJECT_PATH]: buildPaymentObjectXml(),
                    [PAYMENT_RECORD_PAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
                    [PAYMENT_PARENT_LINK_FIELD_PATH]: PAYMENT_PARENT_LINK_FIELD_XML
                }),
                depth: 2
            });

            assert.deepStrictEqual(flexiPageNames(result.relationships), []);
            assert.ok(
                result.relationships.some(
                    (relationship) =>
                        relationship.name === 'Payment__c.Parent_Link__c'
                )
            );
        }
    );

    await runTest(
        'TEST 5: graph discoverer propagates layout ParentObject ingress to structural scan',
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
                repoFiles: [ACCOUNT_OBJECT_PATH, ACCOUNT_RELATED_RECORD_PAGE_PATH],
                readRepoFile: createReadRepoFile({
                    [ACCOUNT_OBJECT_PATH]: ACCOUNT_OBJECT_XML,
                    [ACCOUNT_RELATED_RECORD_PAGE_PATH]:
                        ACCOUNT_RELATED_RECORD_PAGE_XML
                }),
                listRepoFiles: async () => [
                    ACCOUNT_OBJECT_PATH,
                    ACCOUNT_RELATED_RECORD_PAGE_PATH
                ],
                depth: 2
            });

            assert.deepStrictEqual(
                (result.discoveredNodes || [])
                    .filter((node) => node.metadataType === 'FlexiPage')
                    .map((node) => node.name),
                []
            );
        }
    );

    await runTest(
        'TEST 6: RelatedListParentObject graph discoverer still discovers Payment_Record_Page',
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
                repoFiles: [
                    PAYMENT_OBJECT_PATH,
                    PAYMENT_RECORD_PAGE_PATH,
                    PAYMENT_PARENT_LINK_FIELD_PATH
                ],
                readRepoFile: createReadRepoFile({
                    [PAYMENT_OBJECT_PATH]: buildPaymentObjectXml(),
                    [PAYMENT_RECORD_PAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
                    [PAYMENT_PARENT_LINK_FIELD_PATH]: PAYMENT_PARENT_LINK_FIELD_XML
                }),
                listRepoFiles: async () => [
                    PAYMENT_OBJECT_PATH,
                    PAYMENT_RECORD_PAGE_PATH,
                    PAYMENT_PARENT_LINK_FIELD_PATH
                ],
                depth: 2
            });

            assert.deepStrictEqual(
                (result.discoveredNodes || [])
                    .filter((node) => node.metadataType === 'FlexiPage')
                    .map((node) => node.name),
                ['Payment_Record_Page']
            );
        }
    );

    await runTest(
        'TEST 7: PRIMARY_SELECTION CustomObject behavior remains unchanged',
        async () => {
            const repoFiles = [
                PAYMENT_OBJECT_PATH,
                PAYMENT_RECORD_PAGE_PATH,
                ACCOUNT_RELATED_RECORD_PAGE_PATH,
                'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml',
                'force-app/main/default/objects/Payment__c/fields/Member__c.field-meta.xml',
                'force-app/main/default/objects/Payment__c/fields/Amount_Due__c.field-meta.xml',
                'force-app/main/default/objects/Member__c/Member__c.object-meta.xml'
            ];

            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.PRIMARY_SELECTION
                },
                repoFiles,
                readRepoFile: createReadRepoFile({
                    [PAYMENT_OBJECT_PATH]: buildPaymentObjectXml({
                        includeAccountOverride: true
                    }),
                    [PAYMENT_RECORD_PAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
                    [ACCOUNT_RELATED_RECORD_PAGE_PATH]:
                        ACCOUNT_RELATED_RECORD_PAGE_XML,
                    [PAYMENT_OBJECT_PATH.replace(
                        'Payment__c.object-meta.xml',
                        'fields/Account__c.field-meta.xml'
                    )]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
</CustomField>`,
                    [PAYMENT_OBJECT_PATH.replace(
                        'Payment__c.object-meta.xml',
                        'fields/Member__c.field-meta.xml'
                    )]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Member__c</fullName>
    <type>Lookup</type>
    <referenceTo>Member__c</referenceTo>
</CustomField>`,
                    [PAYMENT_OBJECT_PATH.replace(
                        'Payment__c.object-meta.xml',
                        'fields/Amount_Due__c.field-meta.xml'
                    )]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Amount_Due__c</fullName>
    <type>Currency</type>
</CustomField>`,
                    ['force-app/main/default/objects/Member__c/Member__c.object-meta.xml']:
                        `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Member</label>
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <content>Member_Record_Page</content>
    </actionOverrides>
</CustomObject>`
                }),
                listRepoFiles: async () => repoFiles,
                depth: 1
            });

            const flexiPages = (result.discoveredNodes || [])
                .filter((node) => node.metadataType === 'FlexiPage')
                .map((node) => node.name);

            assert.ok(flexiPages.includes('Payment_Record_Page'));
            assert.ok(
                (result.discoveredNodes || []).some(
                    (node) => node.name === 'Member__c'
                )
            );
            assert.ok(result.statistics.reviewsExecuted >= 1);
        }
    );

    await runTest(
        'TEST 8: Layout integration excludes Account_Related_Record_1 but keeps Payment_Record_Page',
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

            const accountReference = (layoutDiscovery.references || []).find(
                (reference) =>
                    reference.metadataType === 'CustomObject' &&
                    reference.name === 'Account'
            );
            const paymentReference = (layoutDiscovery.references || []).find(
                (reference) =>
                    reference.metadataType === 'CustomObject' &&
                    reference.name === 'Payment__c'
            );

            const readRepoFile = createReadRepoFile({
                [ACCOUNT_OBJECT_PATH]: ACCOUNT_OBJECT_XML,
                [ACCOUNT_RELATED_RECORD_PAGE_PATH]: ACCOUNT_RELATED_RECORD_PAGE_XML,
                [PAYMENT_OBJECT_PATH]: buildPaymentObjectXml(),
                [PAYMENT_RECORD_PAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
                [PAYMENT_PARENT_LINK_FIELD_PATH]: PAYMENT_PARENT_LINK_FIELD_XML,
                'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml': `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
</CustomField>`
            });

            const accountGraphResult = await customObjectGraphDiscoverer.discover({
                metadata: {
                    ...accountReference,
                    metadataName: accountReference.name,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY
                },
                repoFiles: [
                    ACCOUNT_OBJECT_PATH,
                    ACCOUNT_RELATED_RECORD_PAGE_PATH,
                    PAYMENT_OBJECT_PATH,
                    PAYMENT_RECORD_PAGE_PATH,
                    PAYMENT_PARENT_LINK_FIELD_PATH,
                    'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml'
                ],
                readRepoFile,
                listRepoFiles: async () => [
                    ACCOUNT_OBJECT_PATH,
                    ACCOUNT_RELATED_RECORD_PAGE_PATH,
                    PAYMENT_OBJECT_PATH,
                    PAYMENT_RECORD_PAGE_PATH,
                    PAYMENT_PARENT_LINK_FIELD_PATH,
                    'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml'
                ],
                depth: 2
            });

            const paymentGraphResult = await customObjectGraphDiscoverer.discover({
                metadata: {
                    ...paymentReference,
                    metadataName: paymentReference.name,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY
                },
                repoFiles: [
                    ACCOUNT_OBJECT_PATH,
                    ACCOUNT_RELATED_RECORD_PAGE_PATH,
                    PAYMENT_OBJECT_PATH,
                    PAYMENT_RECORD_PAGE_PATH,
                    PAYMENT_PARENT_LINK_FIELD_PATH,
                    'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml'
                ],
                readRepoFile,
                listRepoFiles: async () => [
                    ACCOUNT_OBJECT_PATH,
                    ACCOUNT_RELATED_RECORD_PAGE_PATH,
                    PAYMENT_OBJECT_PATH,
                    PAYMENT_RECORD_PAGE_PATH,
                    PAYMENT_PARENT_LINK_FIELD_PATH,
                    'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml'
                ],
                depth: 2
            });

            const graphDependencies = [
                ...(accountGraphResult.discoveredNodes || []),
                ...(paymentGraphResult.discoveredNodes || [])
            ].map((node) => ({
                name: node.name,
                type: node.metadataType,
                metadataType: node.metadataType,
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
                    ['CustomField:Payment__c.Account__c', 'MISSING'],
                    ['CustomField:Payment__c.Parent_Link__c', 'MISSING'],
                    ['FlexiPage:Payment_Record_Page', 'MISSING'],
                    ['FlexiPage:Account_Related_Record_1', 'MISSING']
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
                    },
                    'FlexiPage:Account_Related_Record_1': {
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

            const packageFlexiPages = getPackageMemberNames(
                generatedPackage,
                'FlexiPage'
            );

            assert.ok(packageFlexiPages.includes('Payment_Record_Page'));
            assert.strictEqual(
                packageFlexiPages.includes('Account_Related_Record_1'),
                false
            );
        }
    );
}

main();
