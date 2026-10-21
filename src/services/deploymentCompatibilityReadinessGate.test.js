const assert = require('assert');

const {
    buildBlockingComponentsFromCompatibilityFindings,
    mergeCompatibilityBlockingComponents,
    buildBlockingSummary
} = require('./deploymentCompatibility.service');
const {
    planCompatibilityDeploymentReadiness
} = require('./deploymentReadiness.service');
const deploymentCompatibilityGateService = require('./deploymentCompatibilityGate.service');
const deploymentCheckOnlyGateService = require('./deploymentCheckOnlyGate.service');
const {
    analyzeDeploymentCompatibility
} = require('./deploymentCompatibility/deploymentCompatibilityAnalyzer.service');
const {
    mergeDeployableReferences,
    resolveDependencies
} = require('./dependencyResolution/dependencyResolution.service');
const { generateDeploymentPackage } = require('./deploymentPackage.service');
const layoutReferenceDiscoverer = require('./dependencyResolution/discoverers/layoutReference.discoverer');
const flexiPageReferenceDiscoverer = require('./dependencyResolution/discoverers/flexiPageReference.discoverer');

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

function buildLayoutXml(fields = []) {
    const fieldXml = fields
        .map((field) => `            <field>${field}</field>`)
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <layoutColumns>
            <layoutItems>
${fieldXml}
            </layoutItems>
        </layoutColumns>
    </layoutSections>
</Layout>`;
}

function resolveReadinessFromCompatibilityFindings({
    compatibilityFindings,
    generatedDeploymentPackage,
    impactBlocking = [],
    planBlocking = []
}) {
    const analyzerBlockingComponents =
        buildBlockingComponentsFromCompatibilityFindings(
            compatibilityFindings
        );
    const compatibilityBlockingComponents =
        mergeCompatibilityBlockingComponents(
            impactBlocking,
            planBlocking,
            analyzerBlockingComponents
        );
    const compatibilityDeploymentReadiness =
        planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: generatedDeploymentPackage,
            excludedComponents: [],
            blockingComponents: compatibilityBlockingComponents,
            blockingSummary: buildBlockingSummary(
                compatibilityBlockingComponents
            )
        });

    const deploymentReadiness = {
        readyForDeployment: compatibilityDeploymentReadiness.readyForDeployment,
        blockingComponents: compatibilityDeploymentReadiness.blockingComponents
    };
    const compatibilityDeploymentSkipped =
        deploymentCompatibilityGateService.shouldSkipDeploymentForCompatibility(
            deploymentReadiness
        );
    const checkOnlyDeployment = compatibilityDeploymentSkipped
        ? deploymentCheckOnlyGateService.buildCheckOnlyNotExecutedResult(
              'Pre-validation blocked check-only execution.'
          )
        : { executed: true, status: 'WOULD_EXECUTE' };

    return {
        analyzerBlockingComponents,
        compatibilityBlockingComponents,
        deploymentReadiness,
        compatibilityDeploymentSkipped,
        checkOnlyDeployment
    };
}

const MEMBER_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Member_Record_Page.flexipage-meta.xml';

const MEMBER_RECORD_PAGE_SUBSCRIPTIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Member__c</sobjectType>
    <masterLabel>Member Record Page</masterLabel>
    <type>RecordPage</type>
    <flexiPageRegions>
        <itemInstances>
            <componentInstance>
                <componentInstanceProperties>
                    <name>relatedListApiName</name>
                    <value>Subscriptions__r</value>
                </componentInstanceProperties>
                <componentName>lst:dynamicRelatedList</componentName>
            </componentInstance>
        </itemInstances>
    </flexiPageRegions>
</FlexiPage>`;

async function simulateFlexiPageRelatedListScenario({
    flexiPageXml,
    parentObjectRelationshipIndex,
    destinationStates = new Map()
}) {
    const discovery = await flexiPageReferenceDiscoverer.discover({
        selectedMetadata: [
            {
                metadataType: 'FlexiPage',
                metadataName: 'Member_Record_Page',
                filePath: MEMBER_RECORD_PAGE_PATH
            }
        ],
        repoFiles: [MEMBER_RECORD_PAGE_PATH],
        readRepoFile: async () => flexiPageXml,
        depth: 1
    });

    const selectedMetadata = [
        {
            metadataType: 'FlexiPage',
            metadataName: 'Member_Record_Page',
            filePath: MEMBER_RECORD_PAGE_PATH
        }
    ];

    const compatibility = analyzeDeploymentCompatibility({
        selectedMetadata,
        discoveredReferences: discovery.references,
        resolvedDependencies: [],
        destinationStates,
        parentObjectRelationshipIndex
    });

    const generatedDeploymentPackage = generateDeploymentPackage({
        selectedMetadata,
        requiredDependencies: []
    });

    const readiness = resolveReadinessFromCompatibilityFindings({
        compatibilityFindings: compatibility.findings,
        generatedDeploymentPackage
    });

    return {
        ...readiness,
        compatibility
    };
}

async function simulateLayoutProductionScenario({
    layoutMemberName,
    layoutPath,
    layoutXml,
    destinationStates,
    artifactFlags = {}
}) {
    const discovery = await layoutReferenceDiscoverer.discover({
        selectedMetadata: [
            {
                metadataType: 'Layout',
                metadataName: layoutMemberName,
                filePath: layoutPath
            }
        ],
        repoFiles: [layoutPath],
        readRepoFile: async () => layoutXml,
        depth: 1
    });

    const selectedMetadata = [
        {
            metadataType: 'Layout',
            metadataName: layoutMemberName,
            filePath: layoutPath
        }
    ];

    const mergedDependencies = mergeDeployableReferences(
        [],
        discovery.references
    );
    const resolution = await resolveDependencies({
        requiredDependencies: mergedDependencies,
        discoveredReferences: discovery.references,
        selectedMetadata,
        destinationStates
    });

    const resolvedDependencies = (resolution.resolvedDependencies || []).map(
        (dependency) => {
            const metadataType = dependency.metadataType || dependency.type;
            const metadataName = dependency.name || dependency.metadataName;
            const key = `${metadataType}:${metadataName}`;
            const inventoryState = destinationStates.get(key);
            const flags = artifactFlags[key] || {};

            return {
                ...dependency,
                ...(inventoryState ? { destinationState: inventoryState } : {}),
                ...flags
            };
        }
    );

    const generatedDeploymentPackage = generateDeploymentPackage({
        selectedMetadata,
        requiredDependencies: resolvedDependencies
    });

    const compatibility = analyzeDeploymentCompatibility({
        selectedMetadata,
        discoveredReferences: discovery.references,
        resolvedDependencies,
        destinationStates
    });

    return resolveReadinessFromCompatibilityFindings({
        compatibilityFindings: compatibility.findings,
        generatedDeploymentPackage
    });
}

async function main() {
    const emptyPackage = {
        metadata: [
            {
                metadataType: 'Layout',
                metadataName: 'Account-Gym Member Layout'
            }
        ],
        dependencies: []
    };

    await runTest('TEST 1: layout.fieldReference BLOCK → readyForDeployment=false', async () => {
        const result = resolveReadinessFromCompatibilityFindings({
            compatibilityFindings: [
                {
                    ruleId: 'layout.fieldReference',
                    metadataType: 'CustomField',
                    metadataName: 'Account.DOB__c',
                    status: 'BLOCK',
                    blocking: true,
                    reason: 'Referenced field is missing from the destination org.'
                }
            ],
            generatedDeploymentPackage: emptyPackage
        });

        assert.strictEqual(result.deploymentReadiness.readyForDeployment, false);
        assert.strictEqual(result.compatibilityDeploymentSkipped, true);
        assert.strictEqual(result.checkOnlyDeployment.executed, false);
        assert.strictEqual(result.checkOnlyDeployment.status, 'NOT_EXECUTED');
    });

    await runTest('TEST 2: layout.parentObject BLOCK → readyForDeployment=false', async () => {
        const result = resolveReadinessFromCompatibilityFindings({
            compatibilityFindings: [
                {
                    ruleId: 'layout.parentObject',
                    metadataType: 'CustomObject',
                    metadataName: 'WorkAccess',
                    status: 'BLOCK',
                    blocking: true,
                    reason: 'Layout parent object is missing from the destination org.'
                }
            ],
            generatedDeploymentPackage: emptyPackage
        });

        assert.strictEqual(result.deploymentReadiness.readyForDeployment, false);
        assert.strictEqual(result.compatibilityDeploymentSkipped, true);
        assert.strictEqual(result.checkOnlyDeployment.executed, false);
    });

    await runTest('TEST 3: Layout PASS finding does not block readiness', async () => {
        const result = resolveReadinessFromCompatibilityFindings({
            compatibilityFindings: [
                {
                    ruleId: 'layout.fieldReference',
                    metadataType: 'CustomField',
                    metadataName: 'Account.DOB__c',
                    status: 'PASS',
                    blocking: false,
                    reason: 'Referenced field exists in the destination org.'
                }
            ],
            generatedDeploymentPackage: emptyPackage
        });

        assert.strictEqual(result.deploymentReadiness.readyForDeployment, true);
        assert.strictEqual(result.compatibilityDeploymentSkipped, false);
    });

    await runTest('TEST 4: UNKNOWN finding does not block readiness', async () => {
        const result = resolveReadinessFromCompatibilityFindings({
            compatibilityFindings: [
                {
                    ruleId: 'layout.fieldReference',
                    metadataType: 'CustomField',
                    metadataName: 'Account.DOB__c',
                    status: 'UNKNOWN',
                    blocking: false,
                    reason: 'Unable to validate field.'
                }
            ],
            generatedDeploymentPackage: emptyPackage
        });

        assert.strictEqual(result.deploymentReadiness.readyForDeployment, true);
        assert.strictEqual(result.compatibilityDeploymentSkipped, false);
    });

    await runTest('TEST 5: PermissionSet blocker behavior unchanged', async () => {
        const permissionSetBlocker = {
            metadataType: 'PermissionSet',
            metadataName: 'MyPermSet',
            category: 'PERMISSION_SET_API_VERSION',
            severity: 'BLOCKER',
            status: 'INCOMPATIBLE',
            action: 'BLOCKING',
            reason: 'Permission set API version incompatible.'
        };

        const result = resolveReadinessFromCompatibilityFindings({
            compatibilityFindings: [],
            generatedDeploymentPackage: emptyPackage,
            planBlocking: [permissionSetBlocker]
        });

        assert.strictEqual(result.deploymentReadiness.readyForDeployment, false);
        assert.strictEqual(result.compatibilityDeploymentSkipped, true);
        assert.strictEqual(
            result.compatibilityBlockingComponents[0].metadataName,
            'MyPermSet'
        );
    });

    await runTest(
        'TEST 6: Account-Gym Member Layout production path blocks check-only',
        async () => {
            const result = await simulateLayoutProductionScenario({
                layoutMemberName: 'Account-Gym Member Layout',
                layoutPath:
                    'force-app/main/default/layouts/Account-Gym Member Layout.layout-meta.xml',
                layoutXml: buildLayoutXml(['DOB__c']),
                destinationStates: new Map([
                    ['CustomObject:Account', 'EXISTS'],
                    ['CustomField:Account.DOB__c', 'MISSING']
                ]),
                artifactFlags: {
                    'CustomField:Account.DOB__c': {
                        artifactResolved: false,
                        sourceExists: false
                    }
                }
            });

            const layoutFindingBlock = result.compatibilityBlockingComponents.find(
                (item) =>
                    item.metadataType === 'CustomField' &&
                    item.metadataName === 'Account.DOB__c'
            );

            assert.ok(
                layoutFindingBlock,
                'expected readiness blocker for Account.DOB__c'
            );
            assert.ok(
                ['layout.fieldReference', 'artifact.exists'].includes(
                    layoutFindingBlock.category
                ),
                `unexpected blocker category: ${layoutFindingBlock.category}`
            );
            assert.strictEqual(result.deploymentReadiness.readyForDeployment, false);
            assert.strictEqual(result.compatibilityDeploymentSkipped, true);
            assert.strictEqual(result.checkOnlyDeployment.executed, false);
            assert.strictEqual(result.checkOnlyDeployment.status, 'NOT_EXECUTED');
        }
    );

    await runTest(
        'TEST 6b: layout.fieldReference alone blocks without artifact.exists',
        async () => {
            const result = await simulateLayoutProductionScenario({
                layoutMemberName: 'Account-Gym Member Layout',
                layoutPath:
                    'force-app/main/default/layouts/Account-Gym Member Layout.layout-meta.xml',
                layoutXml: buildLayoutXml(['DOB__c']),
                destinationStates: new Map([
                    ['CustomObject:Account', 'EXISTS'],
                    ['CustomField:Account.DOB__c', 'MISSING']
                ])
            });

            const layoutBlocker = result.compatibilityBlockingComponents.find(
                (item) =>
                    item.category === 'layout.fieldReference' &&
                    item.metadataName === 'Account.DOB__c'
            );

            assert.ok(
                layoutBlocker,
                'expected layout.fieldReference readiness blocker'
            );
            assert.strictEqual(result.deploymentReadiness.readyForDeployment, false);
            assert.strictEqual(result.compatibilityDeploymentSkipped, true);
            assert.strictEqual(result.checkOnlyDeployment.executed, false);
        }
    );

    await runTest(
        'TEST 7: WorkAccess-Access Layout production path blocks check-only',
        async () => {
            const result = await simulateLayoutProductionScenario({
                layoutMemberName: 'WorkAccess-Access Layout',
                layoutPath:
                    'force-app/main/default/layouts/WorkAccess-Access Layout.layout-meta.xml',
                layoutXml: buildLayoutXml(['Name']),
                destinationStates: new Map([['CustomObject:WorkAccess', 'MISSING']]),
                artifactFlags: {
                    'CustomObject:WorkAccess': {
                        artifactResolved: false,
                        sourceExists: false
                    }
                }
            });

            const parentFindingBlock = result.compatibilityBlockingComponents.find(
                (item) =>
                    item.metadataType === 'CustomObject' &&
                    item.metadataName === 'WorkAccess'
            );

            assert.ok(
                parentFindingBlock,
                'expected readiness blocker for WorkAccess'
            );
            assert.ok(
                ['layout.parentObject', 'artifact.exists'].includes(
                    parentFindingBlock.category
                ),
                `unexpected blocker category: ${parentFindingBlock.category}`
            );
            assert.strictEqual(result.deploymentReadiness.readyForDeployment, false);
            assert.strictEqual(result.compatibilityDeploymentSkipped, true);
            assert.strictEqual(result.checkOnlyDeployment.executed, false);
        }
    );

    await runTest(
        'Source-available field PASS does not force readiness false',
        async () => {
            const result = await simulateLayoutProductionScenario({
                layoutMemberName: 'Account-Gym Member Layout',
                layoutPath:
                    'force-app/main/default/layouts/Account-Gym Member Layout.layout-meta.xml',
                layoutXml: buildLayoutXml(['DOB__c']),
                destinationStates: new Map([
                    ['CustomObject:Account', 'EXISTS'],
                    ['CustomField:Account.DOB__c', 'MISSING']
                ]),
                artifactFlags: {
                    'CustomField:Account.DOB__c': {
                        artifactResolved: true,
                        sourceExists: true
                    }
                }
            });

            const layoutBlocker = result.analyzerBlockingComponents.find(
                (item) => item.metadataName === 'Account.DOB__c'
            );

            assert.strictEqual(layoutBlocker, undefined);
            assert.strictEqual(result.deploymentReadiness.readyForDeployment, true);
            assert.strictEqual(result.compatibilityDeploymentSkipped, false);
        }
    );

    await runTest(
        'TEST 7: primary FlexiPage missing related list BLOCK blocks check-only',
        async () => {
            const result = await simulateFlexiPageRelatedListScenario({
                flexiPageXml: MEMBER_RECORD_PAGE_SUBSCRIPTIONS_XML,
                parentObjectRelationshipIndex: new Map([
                    [
                        'Member__c',
                        {
                            queried: true,
                            ok: true,
                            warning: null,
                            childRelationships: [
                                { relationshipName: 'Sessions' }
                            ]
                        }
                    ]
                ])
            });

            const relatedListBlocker = result.analyzerBlockingComponents.find(
                (item) =>
                    item.metadataType === 'FlexiPageRelatedList' &&
                    item.metadataName === 'Member__c.Subscriptions__r'
            );

            assert.ok(relatedListBlocker);
            assert.strictEqual(
                relatedListBlocker.category,
                'flexiPage.relatedListRelationship'
            );
            assert.strictEqual(result.deploymentReadiness.readyForDeployment, false);
            assert.strictEqual(result.compatibilityDeploymentSkipped, true);
            assert.strictEqual(result.checkOnlyDeployment.executed, false);
        }
    );
}

main();
