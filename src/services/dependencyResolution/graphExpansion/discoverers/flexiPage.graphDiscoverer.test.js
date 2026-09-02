const assert = require('assert');

const flexiPageReferenceDiscoverer = require('../../discoverers/flexiPageReference.discoverer');
const flexiPageGraphDiscoverer = require('./flexiPage.graphDiscoverer');
const customObjectGraphDiscoverer = require('./customObject.graphDiscoverer');
const layoutReferenceDiscoverer = require('../../discoverers/layoutReference.discoverer');
const {
    METADATA_ORIGINS
} = require('../../metadataGraphOrigin.model');
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

const FLEXIPAGE_PATH =
    'force-app/main/default/flexipages/Payment_Record_Page.flexipage-meta.xml';
const PAYMENT_OBJECT_PATH =
    'force-app/main/default/objects/Payment__c/Payment__c.object-meta.xml';
const PAYMENT_ACCOUNT_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Account__c.field-meta.xml';
const PAYMENT_PARENT_LINK_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Parent_Link__c.field-meta.xml';
const PAYMENT_MEMBER_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Member__c.field-meta.xml';
const PAYMENT_AMOUNT_FIELD_PATH =
    'force-app/main/default/objects/Payment__c/fields/Amount_Due__c.field-meta.xml';

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

const PAYMENT_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Payment__c</sobjectType>
    <flexiPageRegions>
        <itemInstances>
            <fieldInstance>
                <fieldItem>Record.Amount__c</fieldItem>
            </fieldInstance>
            <fieldInstance>
                <fieldItem>Record.Member__c</fieldItem>
            </fieldInstance>
            <fieldInstance>
                <fieldItem>Record.Subscription__c</fieldItem>
            </fieldInstance>
            <componentInstance>
                <componentName>c:refundPayment</componentName>
            </componentInstance>
        </itemInstances>
        <name>main</name>
        <type>Region</type>
    </flexiPageRegions>
    <masterLabel>Payment Record Page</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

const REPO_FILES = [
    FLEXIPAGE_PATH,
    PAYMENT_OBJECT_PATH,
    PAYMENT_ACCOUNT_FIELD_PATH,
    PAYMENT_PARENT_LINK_FIELD_PATH,
    PAYMENT_MEMBER_FIELD_PATH,
    PAYMENT_AMOUNT_FIELD_PATH
];

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    if (normalized === FLEXIPAGE_PATH) {
        return PAYMENT_RECORD_PAGE_XML;
    }

    if (normalized === PAYMENT_OBJECT_PATH) {
        return PAYMENT_OBJECT_XML;
    }

    if (normalized.endsWith('.field-meta.xml')) {
        if (normalized.includes('Parent_Link__c')) {
            return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Parent_Link__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Member__c</referenceTo>
</CustomField>`;
        }

        if (normalized.includes('Member__c')) {
            return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Member__c</fullName>
    <type>Lookup</type>
    <referenceTo>Member__c</referenceTo>
</CustomField>`;
        }

        if (normalized.includes('Amount_Due__c')) {
            return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Amount_Due__c</fullName>
    <type>Currency</type>
</CustomField>`;
        }

        if (normalized.includes('Account__c')) {
            return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
</CustomField>`;
        }
    }

    throw new Error(`Unexpected read: ${filePath}`);
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
        'TEST 1: structural ActionOverride FlexiPage skips child discovery',
        async () => {
            let referenceDiscovererCalled = false;
            const originalDiscover = flexiPageReferenceDiscoverer.discover;

            flexiPageReferenceDiscoverer.discover = async () => {
                referenceDiscovererCalled = true;
                return {
                    references: [],
                    warnings: [],
                    metadataScanned: 0,
                    filesScanned: 0
                };
            };

            try {
                const result = await flexiPageGraphDiscoverer.discover({
                    metadata: {
                        metadataType: 'FlexiPage',
                        metadataName: 'Payment_Record_Page',
                        name: 'Payment_Record_Page',
                        filePath: FLEXIPAGE_PATH,
                        origin: METADATA_ORIGINS.DIRECT_DEPENDENCY,
                        relationship: 'ActionOverride',
                        discoveryMethod: 'actionOverrides',
                        sourceMetadata: 'Payment__c'
                    },
                    repoFiles: REPO_FILES,
                    readRepoFile: async () => {
                        throw new Error('readRepoFile must not be called');
                    },
                    depth: 3
                });

                assert.strictEqual(referenceDiscovererCalled, false);
                assert.deepStrictEqual(result.discoveredNodes, []);
                assert.deepStrictEqual(result.discoveredEdges, []);
            } finally {
                flexiPageReferenceDiscoverer.discover = originalDiscover;
            }
        }
    );

    await runTest(
        'TEST 2: PRIMARY FlexiPage keeps full field and component discovery',
        async () => {
            const result = await flexiPageGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'FlexiPage',
                    metadataName: 'Payment_Record_Page',
                    name: 'Payment_Record_Page',
                    filePath: FLEXIPAGE_PATH,
                    origin: METADATA_ORIGINS.PRIMARY_SELECTION
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                depth: 1
            });

            assert.ok(
                nodeNames(result, 'CustomField').includes('Payment__c.Amount__c')
            );
            assert.ok(
                nodeNames(result, 'CustomField').includes('Payment__c.Member__c')
            );
            assert.ok(
                nodeNames(result, 'LightningComponentBundle').includes(
                    'refundPayment'
                )
            );
        }
    );

    await runTest(
        'TEST 3: PRIMARY CustomObject ActionOverride FlexiPage keeps full expansion',
        async () => {
            const result = await flexiPageGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'FlexiPage',
                    metadataName: 'Payment_Record_Page',
                    name: 'Payment_Record_Page',
                    filePath: FLEXIPAGE_PATH,
                    origin: METADATA_ORIGINS.RELATIONSHIP_TARGET,
                    relationship: 'ActionOverride',
                    discoveryMethod: 'actionOverrides',
                    sourceMetadata: 'Payment__c'
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                depth: 2
            });

            assert.ok(
                nodeNames(result, 'CustomField').includes('Payment__c.Member__c')
            );
            assert.ok(
                nodeNames(result, 'LightningComponentBundle').includes(
                    'refundPayment'
                )
            );
        }
    );

    await runTest(
        'TEST 4: non-structural FlexiPage tuple keeps full expansion',
        async () => {
            const result = await flexiPageGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'FlexiPage',
                    metadataName: 'Payment_Record_Page',
                    name: 'Payment_Record_Page',
                    filePath: FLEXIPAGE_PATH,
                    origin: METADATA_ORIGINS.DIRECT_DEPENDENCY,
                    relationship: 'Field',
                    discoveryMethod: 'flexiPageReference',
                    sourceMetadata: 'Payment_Record_Page'
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                depth: 2
            });

            assert.ok(
                nodeNames(result, 'CustomField').includes('Payment__c.Amount__c')
            );
        }
    );

    await runTest(
        'TEST 5: Layout integration keeps structural FlexiPage without FlexiPage-layer expansion',
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

            const objectGraphResult = await customObjectGraphDiscoverer.discover({
                metadata: {
                    metadataType: 'CustomObject',
                    metadataName: 'Payment__c',
                    name: 'Payment__c',
                    filePath: PAYMENT_OBJECT_PATH,
                    origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES,
                depth: 2
            });

            const flexiPageNode = (objectGraphResult.discoveredNodes || []).find(
                (node) =>
                    node.metadataType === 'FlexiPage' &&
                    node.name === 'Payment_Record_Page'
            );

            assert.ok(flexiPageNode, 'expected structural Payment_Record_Page node');

            const flexiPageExpansion = await flexiPageGraphDiscoverer.discover({
                metadata: {
                    ...flexiPageNode,
                    metadataName: flexiPageNode.name
                },
                repoFiles: REPO_FILES,
                readRepoFile,
                depth: 3
            });

            assert.deepStrictEqual(flexiPageExpansion.discoveredNodes, []);

            const graphDependencies = (objectGraphResult.discoveredNodes || []).map(
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

            const packageFields = getPackageMemberNames(
                generatedPackage,
                'CustomField'
            );
            const packageFlexiPages = getPackageMemberNames(
                generatedPackage,
                'FlexiPage'
            );
            const packageLwcs = getPackageMemberNames(
                generatedPackage,
                'LightningComponentBundle'
            );
            const packageApex = getPackageMemberNames(
                generatedPackage,
                'ApexClass'
            );

            assert.ok(packageFlexiPages.includes('Payment_Record_Page'));
            assert.ok(packageFields.includes('Payment__c.Account__c'));
            assert.ok(packageFields.includes('Payment__c.Parent_Link__c'));
            assert.strictEqual(
                packageFields.includes('Payment__c.Amount__c'),
                false
            );
            assert.strictEqual(
                packageFields.includes('Payment__c.Amount_Due__c'),
                false
            );
            assert.strictEqual(
                packageFields.includes('Payment__c.Member__c'),
                false
            );
            assert.strictEqual(
                packageFields.includes('Payment__c.Subscription__c'),
                false
            );
            assert.strictEqual(packageLwcs.includes('refundPayment'), false);
            assert.strictEqual(
                packageApex.includes('PaymentRefundController'),
                false
            );
        }
    );
}

main();
