const assert = require('assert');

const flexiPageGraphDiscoverer = require('./discoverers/flexiPage.graphDiscoverer');
const flexiPageReferenceDiscoverer = require('../discoverers/flexiPageReference.discoverer');
const {
    METADATA_ORIGINS
} = require('../metadataGraphOrigin.model');
const {
    collectDestinationInventoryItems
} = require('../../destinationInventory/destinationInventoryCandidateCollector.service');
const {
    DISCOVERY_METHOD: COMPONENT_DISCOVERY_METHOD,
    discoverStructuralActionOverrideComponents,
    isStructuralActionOverrideFlexiPageDependency
} = require('./structuralActionOverrideComponent.discoverer');
const {
    DISCOVERY_METHOD: APEX_DISCOVERY_METHOD,
    discoverStructuralActionOverrideApexClasses
} = require('./structuralActionOverrideApex.discoverer');
const {
    discoverBoundedLwcApexPrerequisites
} = require('./structuralActionOverrideComponent.closure.service');
const {
    mergeDeployableReferences,
    resolveDependencies
} = require('../dependencyResolution.service');
const { generateDeploymentPackage } = require('../../deploymentPackage.service');
const {
    analyzeLwcAndFlexiDependencies,
    CATEGORIES
} = require('../../deploymentCompatibility.service');

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
const REFUND_PAYMENT_JS_PATH =
    'force-app/main/default/lwc/refundPayment/refundPayment.js';
const UNRELATED_LWC_JS_PATH =
    'force-app/main/default/lwc/otherWidget/otherWidget.js';
const UNRELATED_APEX_PATH =
    'force-app/main/default/classes/UnrelatedController.cls';

const PAYMENT_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Payment__c</sobjectType>
    <flexiPageRegions>
        <itemInstances>
            <componentInstance>
                <componentName>c:refundPayment</componentName>
            </componentInstance>
            <componentInstance>
                <componentName>force:detailPanel</componentName>
            </componentInstance>
        </itemInstances>
        <name>main</name>
        <type>Region</type>
    </flexiPageRegions>
    <masterLabel>Payment Record Page</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;

const REFUND_PAYMENT_JS = `
import processRefund from '@salesforce/apex/PaymentRefundController.processRefund';

export default class RefundPayment extends LightningElement {
    handleRefund() {
        return processRefund();
    }
}
`;

const UNRELATED_LWC_JS = `
import helper from '@salesforce/apex/UnrelatedController.run';
export default class OtherWidget {}
`;

const FILE_CONTENT = {
    [FLEXIPAGE_PATH]: PAYMENT_RECORD_PAGE_XML,
    [REFUND_PAYMENT_JS_PATH]: REFUND_PAYMENT_JS,
    [UNRELATED_LWC_JS_PATH]: UNRELATED_LWC_JS,
    [UNRELATED_APEX_PATH]: 'public class UnrelatedController {}'
};

const REPO_FILES = Object.keys(FILE_CONTENT);

function createReadRepoFile(files = FILE_CONTENT) {
    return async (targetPath) => {
        if (!files[targetPath]) {
            throw new Error(`Missing fixture file: ${targetPath}`);
        }

        return files[targetPath];
    };
}

function createStructuralPaymentRecordPageDependency() {
    return {
        name: 'Payment_Record_Page',
        type: 'FlexiPage',
        metadataType: 'FlexiPage',
        relationship: 'ActionOverride',
        discoveryMethod: 'actionOverrides',
        origin: METADATA_ORIGINS.DIRECT_DEPENDENCY,
        sourceMetadata: 'Payment__c',
        required: true,
        selected: true,
        deployable: true,
        blocking: true,
        filePath: FLEXIPAGE_PATH
    };
}

function getPackageMemberNames(generatedPackage, metadataType) {
    return (generatedPackage?.metadata || [])
        .filter((item) => item.metadataType === metadataType)
        .map((item) => item.metadataName);
}

async function main() {
    await runTest(
        'TEST 1: structural ActionOverride FlexiPage discovers refundPayment LWC',
        async () => {
            const result = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            assert.deepStrictEqual(
                result.dependencies.map((item) => item.name),
                ['refundPayment']
            );
            assert.strictEqual(
                result.dependencies[0].metadataType,
                'LightningComponentBundle'
            );
        }
    );

    await runTest(
        'TEST 2: PRIMARY FlexiPage does not use bounded component discoverer',
        async () => {
            const result = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    {
                        ...createStructuralPaymentRecordPageDependency(),
                        origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
                    }
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            assert.deepStrictEqual(result.dependencies, []);
        }
    );

    await runTest(
        'TEST 3: LWC candidate preserves structuralActionOverrideComponent provenance',
        async () => {
            const result = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            const dependency = result.dependencies[0];

            assert.strictEqual(dependency.discoveryMethod, COMPONENT_DISCOVERY_METHOD);
            assert.strictEqual(dependency.sourceMetadata, 'Payment_Record_Page');
            assert.strictEqual(dependency.relationship, 'ActionOverrideComponent');
            assert.strictEqual(dependency.expansionPolicy, 'PREREQUISITE_ONLY');
        }
    );

    await runTest(
        'TEST 4: LWC enters closureInventoryCandidates',
        async () => {
            const discovery = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            const inventoryItems = collectDestinationInventoryItems({
                closureCandidates: discovery.closureCandidates
            });

            assert.ok(
                inventoryItems.some(
                    (item) =>
                        item.metadataType === 'LightningComponentBundle' &&
                        item.metadataName === 'refundPayment'
                )
            );
        }
    );

    await runTest(
        'TEST 5: LWC destination EXISTS → SKIP',
        async () => {
            const discovery = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            const resolution = await resolveDependencies({
                requiredDependencies: [
                    createStructuralPaymentRecordPageDependency(),
                    ...discovery.dependencies
                ],
                destinationStates: new Map([
                    ['FlexiPage:Payment_Record_Page', 'MISSING'],
                    ['LightningComponentBundle:refundPayment', 'EXISTS']
                ])
            });

            const lwcDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'refundPayment'
            );

            assert.ok(lwcDecision);
            assert.strictEqual(lwcDecision.action, 'SKIP');
            assert.strictEqual(lwcDecision.destinationState, 'EXISTS');
        }
    );

    await runTest(
        'TEST 6: LWC destination MISSING → DEPLOY',
        async () => {
            const discovery = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            const resolution = await resolveDependencies({
                requiredDependencies: [
                    createStructuralPaymentRecordPageDependency(),
                    ...discovery.dependencies
                ],
                destinationStates: new Map([
                    ['FlexiPage:Payment_Record_Page', 'MISSING'],
                    ['LightningComponentBundle:refundPayment', 'MISSING']
                ])
            });

            const lwcDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'refundPayment'
            );

            assert.ok(lwcDecision);
            assert.strictEqual(lwcDecision.action, 'DEPLOY');
            assert.strictEqual(lwcDecision.destinationState, 'MISSING');
        }
    );

    await runTest(
        'TEST 7: LWC destination UNKNOWN preserves fail-open DEPLOY',
        async () => {
            const discovery = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            const resolution = await resolveDependencies({
                requiredDependencies: discovery.dependencies,
                destinationStates: new Map()
            });

            const lwcDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'refundPayment'
            );

            assert.ok(lwcDecision);
            assert.strictEqual(lwcDecision.destinationState, 'UNKNOWN');
            assert.strictEqual(lwcDecision.action, 'DEPLOY');
        }
    );

    await runTest(
        'TEST 8: refundPayment discovers PaymentRefundController Apex',
        async () => {
            const componentDiscovery =
                await discoverStructuralActionOverrideComponents({
                    structuralFlexiPageDependencies: [
                        createStructuralPaymentRecordPageDependency()
                    ],
                    readRepoFile: createReadRepoFile(),
                    repoFiles: REPO_FILES
                });

            const apexDiscovery = await discoverStructuralActionOverrideApexClasses(
                {
                    structuralComponentDependencies:
                        componentDiscovery.dependencies,
                    readRepoFile: createReadRepoFile(),
                    repoFiles: REPO_FILES
                }
            );

            assert.deepStrictEqual(
                apexDiscovery.dependencies.map((item) => item.name),
                ['PaymentRefundController']
            );
            assert.strictEqual(
                apexDiscovery.dependencies[0].metadataType,
                'ApexClass'
            );
        }
    );

    await runTest(
        'TEST 9: Apex provenance is preserved',
        async () => {
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ]
            });

            const apexDependency = closure.dependencies.find(
                (item) => item.metadataType === 'ApexClass'
            );

            assert.ok(apexDependency);
            assert.strictEqual(apexDependency.discoveryMethod, APEX_DISCOVERY_METHOD);
            assert.strictEqual(apexDependency.sourceMetadata, 'refundPayment');
            assert.strictEqual(apexDependency.relationship, 'LwcApexDependency');
            assert.strictEqual(apexDependency.expansionPolicy, 'TERMINAL');
        }
    );

    await runTest(
        'TEST 10: Apex enters the same inventory candidate set',
        async () => {
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ]
            });

            const inventoryItems = collectDestinationInventoryItems({
                closureCandidates: closure.closureCandidates
            });

            assert.ok(
                inventoryItems.some(
                    (item) =>
                        item.metadataType === 'LightningComponentBundle' &&
                        item.metadataName === 'refundPayment'
                )
            );
            assert.ok(
                inventoryItems.some(
                    (item) =>
                        item.metadataType === 'ApexClass' &&
                        item.metadataName === 'PaymentRefundController'
                )
            );
        }
    );

    await runTest(
        'TEST 11: Apex destination EXISTS → SKIP',
        async () => {
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ]
            });

            const resolution = await resolveDependencies({
                requiredDependencies: closure.dependencies,
                destinationStates: new Map([
                    ['LightningComponentBundle:refundPayment', 'MISSING'],
                    ['ApexClass:PaymentRefundController', 'EXISTS']
                ])
            });

            const apexDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'PaymentRefundController'
            );

            assert.ok(apexDecision);
            assert.strictEqual(apexDecision.action, 'SKIP');
        }
    );

    await runTest(
        'TEST 12: Apex destination MISSING → DEPLOY',
        async () => {
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ]
            });

            const resolution = await resolveDependencies({
                requiredDependencies: closure.dependencies,
                destinationStates: new Map([
                    ['ApexClass:PaymentRefundController', 'MISSING']
                ])
            });

            const apexDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'PaymentRefundController'
            );

            assert.ok(apexDecision);
            assert.strictEqual(apexDecision.action, 'DEPLOY');
        }
    );

    await runTest(
        'TEST 13: Apex destination UNKNOWN preserves fail-open DEPLOY',
        async () => {
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ]
            });

            const resolution = await resolveDependencies({
                requiredDependencies: closure.dependencies,
                destinationStates: new Map()
            });

            const apexDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'PaymentRefundController'
            );

            assert.ok(apexDecision);
            assert.strictEqual(apexDecision.action, 'DEPLOY');
            assert.strictEqual(apexDecision.destinationState, 'UNKNOWN');
        }
    );

    await runTest(
        'TEST 14: Apex dependency is terminal (no recursive Apex expansion)',
        async () => {
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ]
            });

            assert.strictEqual(
                closure.dependencies.filter(
                    (item) => item.metadataType === 'ApexClass'
                ).length,
                1
            );
            assert.strictEqual(
                closure.dependencies.some(
                    (item) => item.name === 'UnrelatedController'
                ),
                false
            );
        }
    );

    await runTest(
        'TEST 15: no unrelated LWC bundles discovered',
        async () => {
            const result = await discoverStructuralActionOverrideComponents({
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            assert.strictEqual(
                result.dependencies.some((item) => item.name === 'otherWidget'),
                false
            );
        }
    );

    await runTest(
        'TEST 16: existing FlexiPage structural guard still prevents graph expansion',
        async () => {
            const originalDiscover = flexiPageReferenceDiscoverer.discover;
            let referenceDiscovererCalled = false;

            flexiPageReferenceDiscoverer.discover = async () => {
                referenceDiscovererCalled = true;
                return {
                    references: [],
                    metadataScanned: 0,
                    filesScanned: 0,
                    warnings: []
                };
            };

            try {
                const result = await flexiPageGraphDiscoverer.discover({
                    metadata: createStructuralPaymentRecordPageDependency(),
                    repoFiles: REPO_FILES,
                    readRepoFile: createReadRepoFile(),
                    depth: 3
                });

                assert.strictEqual(referenceDiscovererCalled, false);
                assert.deepStrictEqual(result.discoveredNodes, []);
            } finally {
                flexiPageReferenceDiscoverer.discover = originalDiscover;
            }
        }
    );

    await runTest(
        'TEST 17: provenance survives mergeDeployableReferences',
        async () => {
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [
                    createStructuralPaymentRecordPageDependency()
                ]
            });

            const merged = mergeDeployableReferences(
                [createStructuralPaymentRecordPageDependency()],
                closure.dependencies
            );

            const lwc = merged.find((item) => item.name === 'refundPayment');
            const apex = merged.find(
                (item) => item.name === 'PaymentRefundController'
            );

            assert.strictEqual(lwc.discoveryMethod, COMPONENT_DISCOVERY_METHOD);
            assert.strictEqual(lwc.sourceMetadata, 'Payment_Record_Page');
            assert.strictEqual(apex.discoveryMethod, APEX_DISCOVERY_METHOD);
            assert.strictEqual(apex.sourceMetadata, 'refundPayment');
        }
    );

    await runTest(
        'TEST 18: compatibility skips LWC warning when destination EXISTS',
        async () => {
            const membership = {
                keys: new Set(['FlexiPage:Payment_Record_Page']),
                byType: new Map(),
                items: []
            };
            const warnings = analyzeLwcAndFlexiDependencies(
                {
                    metadataType: 'FlexiPage',
                    metadataName: 'Payment_Record_Page'
                },
                PAYMENT_RECORD_PAGE_XML,
                membership,
                new Map([['LightningComponentBundle:refundPayment', 'EXISTS']])
            );

            assert.strictEqual(
                warnings.some(
                    (warning) =>
                        warning.category === CATEGORIES.FLEXIPAGE_DEPENDENCY
                ),
                false
            );
        }
    );

    await runTest(
        'TEST 19: end-to-end missing destination includes LWC and Apex in package',
        async () => {
            const flexiPage = createStructuralPaymentRecordPageDependency();
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [flexiPage]
            });

            const resolution = await resolveDependencies({
                requiredDependencies: [flexiPage, ...closure.dependencies],
                destinationStates: new Map([
                    ['FlexiPage:Payment_Record_Page', 'MISSING'],
                    ['LightningComponentBundle:refundPayment', 'MISSING'],
                    ['ApexClass:PaymentRefundController', 'MISSING']
                ])
            });

            const generatedPackage = generateDeploymentPackage({
                selectedMetadata: [],
                requiredDependencies: resolution.resolvedDependencies
            });

            assert.ok(
                getPackageMemberNames(
                    generatedPackage,
                    'LightningComponentBundle'
                ).includes('refundPayment')
            );
            assert.ok(
                getPackageMemberNames(generatedPackage, 'ApexClass').includes(
                    'PaymentRefundController'
                )
            );
        }
    );

    await runTest(
        'TEST 20: end-to-end existing destination excludes LWC and Apex from package',
        async () => {
            const flexiPage = createStructuralPaymentRecordPageDependency();
            const closure = await discoverBoundedLwcApexPrerequisites({
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES,
                structuralFlexiPageDependencies: [flexiPage]
            });

            const resolution = await resolveDependencies({
                requiredDependencies: [flexiPage, ...closure.dependencies],
                destinationStates: new Map([
                    ['FlexiPage:Payment_Record_Page', 'MISSING'],
                    ['LightningComponentBundle:refundPayment', 'EXISTS'],
                    ['ApexClass:PaymentRefundController', 'EXISTS']
                ])
            });

            const generatedPackage = generateDeploymentPackage({
                selectedMetadata: [],
                requiredDependencies: resolution.resolvedDependencies
            });

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
            assert.ok(
                getPackageMemberNames(generatedPackage, 'FlexiPage').includes(
                    'Payment_Record_Page'
                )
            );
        }
    );

    await runTest(
        'TEST 21: isStructuralActionOverrideFlexiPageDependency boundary tuple',
        async () => {
            assert.strictEqual(
                isStructuralActionOverrideFlexiPageDependency(
                    createStructuralPaymentRecordPageDependency()
                ),
                true
            );
            assert.strictEqual(
                isStructuralActionOverrideFlexiPageDependency({
                    ...createStructuralPaymentRecordPageDependency(),
                    origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
                }),
                false
            );
        }
    );
}

main().then(() => {
    if (process.exitCode) {
        process.exit(process.exitCode);
    }
});
