const assert = require('assert');

const {
    buildDeploymentPackageProvenance,
    PACKAGE_ROLES,
    ORIGIN_TYPES,
    SCHEMA_VERSION
} = require('./deploymentPackageProvenance.service');

const deploymentPackageService = require('./deploymentPackage.service');

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

runTest('empty package yields empty provenance members', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [],
            dependencies: [],
            testClasses: [],
            summary: {}
        },
        selectedMetadata: []
    });

    assert.strictEqual(result.schemaVersion, SCHEMA_VERSION);
    assert.ok(typeof result.generatedAt === 'string');
    assert.deepStrictEqual(result.summary, {
        memberCount: 0,
        primaryCount: 0,
        autoIncludedCount: 0,
        multiOriginCount: 0
    });
    assert.deepStrictEqual(result.members, []);
});

runTest('primary selected metadata is USER_SELECTED / PRIMARY', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'MyController'
                }
            ],
            dependencies: []
        },
        selectedMetadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'MyController'
            }
        ],
        discoveredRelationships: [],
        discoveredReferences: [],
        resolvedDependencies: []
    });

    assert.strictEqual(result.members.length, 1);
    assert.strictEqual(result.members[0].packageRole, PACKAGE_ROLES.PRIMARY);
    assert.strictEqual(result.members[0].origins.length, 1);
    assert.strictEqual(
        result.members[0].origins[0].originType,
        ORIGIN_TYPES.USER_SELECTED
    );
    assert.strictEqual(result.summary.primaryCount, 1);
    assert.strictEqual(result.summary.autoIncludedCount, 0);
});

runTest('relationship discovery produces RELATIONSHIP_DEPENDENCY', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Account__c'
                }
            ],
            dependencies: []
        },
        selectedMetadata: [],
        discoveredRelationships: [
            {
                name: 'Account__c',
                metadataType: 'CustomObject',
                relationship: 'Lookup',
                discoveredBy: 'CustomObjectRelationshipDiscoverer',
                sourceMetadata: 'Child__c',
                reason: 'Lookup target discovered from field metadata.'
            }
        ],
        discoveredReferences: [],
        resolvedDependencies: []
    });

    const member = result.members[0];
    assert.strictEqual(member.packageRole, PACKAGE_ROLES.AUTO_INCLUDED);
    assert.strictEqual(
        member.origins[0].originType,
        ORIGIN_TYPES.RELATIONSHIP_DEPENDENCY
    );
    assert.strictEqual(member.origins[0].relatedMetadataName, 'Child__c');
    assert.strictEqual(member.origins[0].relationKind, 'Lookup');
});

runTest('DeploymentReview discovery produces REVIEW_DEPENDENCY', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Parent__c'
                }
            ],
            dependencies: []
        },
        selectedMetadata: [],
        discoveredRelationships: [
            {
                name: 'Parent__c',
                type: 'CustomObject',
                relationship: 'DeploymentReview',
                discoveredBy: 'DeploymentReview',
                sourceMetadata: 'ChildController',
                reason: 'Discovered by Deployment Review of ChildController.'
            }
        ],
        discoveredReferences: [],
        resolvedDependencies: []
    });

    assert.strictEqual(
        result.members[0].origins[0].originType,
        ORIGIN_TYPES.REVIEW_DEPENDENCY
    );
});

runTest('reference discovery produces METADATA_REFERENCE', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'LightningComponentBundle',
                    metadataName: 'myCmp'
                }
            ],
            dependencies: []
        },
        selectedMetadata: [],
        discoveredRelationships: [],
        discoveredReferences: [
            {
                name: 'myCmp',
                metadataType: 'LightningComponentBundle',
                referenceType: 'component',
                discoveredBy: 'FlexiPageReferenceDiscoverer',
                sourceMetadata: 'Account_Record_Page',
                reason: 'Lightning component referenced by FlexiPage.',
                deployable: true,
                blocking: true
            }
        ],
        resolvedDependencies: []
    });

    assert.strictEqual(
        result.members[0].origins[0].originType,
        ORIGIN_TYPES.METADATA_REFERENCE
    );
    assert.strictEqual(
        result.members[0].origins[0].relatedMetadataType,
        'FlexiPage'
    );
});

runTest('RESOLVER decision produces RESOLUTION_REQUIREMENT', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Missing__c'
                }
            ],
            dependencies: [
                {
                    name: 'Missing__c',
                    type: 'CustomObject',
                    action: 'DEPLOY',
                    selected: true,
                    source: 'RESOLVER',
                    relationship: 'Lookup',
                    reason:
                        'Lookup target is missing in destination; include object metadata in the deployment package.'
                }
            ]
        },
        selectedMetadata: [],
        discoveredRelationships: [],
        discoveredReferences: [],
        resolvedDependencies: [
            {
                name: 'Missing__c',
                type: 'CustomObject',
                action: 'DEPLOY',
                selected: true,
                source: 'RESOLVER',
                relationship: 'Lookup',
                reason:
                    'Lookup target is missing in destination; include object metadata in the deployment package.'
            }
        ]
    });

    const originTypes = result.members[0].origins.map((o) => o.originType);
    assert.ok(
        originTypes.includes(ORIGIN_TYPES.RESOLUTION_REQUIREMENT),
        `expected RESOLUTION_REQUIREMENT in ${originTypes.join(',')}`
    );
});

runTest('multiple origins are preserved without collapsing', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Shared__c'
                }
            ],
            dependencies: []
        },
        selectedMetadata: [
            {
                metadataType: 'CustomObject',
                metadataName: 'Shared__c'
            }
        ],
        discoveredRelationships: [
            {
                name: 'Shared__c',
                metadataType: 'CustomObject',
                relationship: 'MasterDetail',
                discoveredBy: 'CustomObjectRelationshipDiscoverer',
                sourceMetadata: 'Child__c',
                reason: 'MasterDetail target discovered from field metadata.'
            }
        ],
        discoveredReferences: [],
        resolvedDependencies: []
    });

    const originTypes = result.members[0].origins.map((o) => o.originType);
    assert.deepStrictEqual(originTypes, [
        ORIGIN_TYPES.USER_SELECTED,
        ORIGIN_TYPES.RELATIONSHIP_DEPENDENCY
    ]);
    assert.strictEqual(result.summary.multiOriginCount, 1);
});

runTest('undetermined provenance returns UNKNOWN — never guesses', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'MysteryClass'
                }
            ],
            dependencies: []
        },
        selectedMetadata: [],
        discoveredRelationships: [],
        discoveredReferences: [],
        resolvedDependencies: [
            {
                name: 'MysteryClass',
                type: 'ApexClass',
                action: 'DEPLOY',
                selected: true,
                source: 'DEFAULT',
                reason: 'Default deployment behavior preserved.'
            }
        ]
    });

    assert.strictEqual(result.members[0].packageRole, PACKAGE_ROLES.AUTO_INCLUDED);
    assert.strictEqual(result.members[0].origins.length, 1);
    assert.strictEqual(
        result.members[0].origins[0].originType,
        ORIGIN_TYPES.UNKNOWN
    );
});

runTest('DEFAULT source alone does not invent RESOLUTION_REQUIREMENT', () => {
    const result = buildDeploymentPackageProvenance({
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'LegacyDep'
                }
            ],
            dependencies: [
                {
                    name: 'LegacyDep',
                    type: 'ApexClass',
                    source: 'DEFAULT',
                    reason: 'Default deployment behavior preserved.'
                }
            ]
        },
        selectedMetadata: [],
        discoveredRelationships: [],
        discoveredReferences: [],
        resolvedDependencies: []
    });

    assert.strictEqual(
        result.members[0].origins[0].originType,
        ORIGIN_TYPES.UNKNOWN
    );
});

runTest('projection does not mutate generatedDeploymentPackage', () => {
    const generatedDeploymentPackage = {
        metadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'Stable'
            }
        ],
        dependencies: [],
        testClasses: [],
        summary: { metadataCount: 1 }
    };
    const before = JSON.stringify(generatedDeploymentPackage);

    buildDeploymentPackageProvenance({
        generatedDeploymentPackage,
        selectedMetadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'Stable'
            }
        ]
    });

    assert.strictEqual(JSON.stringify(generatedDeploymentPackage), before);
});

runTest('Package Builder output shape remains unchanged when composing package', () => {
    const selectedMetadata = [
        {
            metadataType: 'ApexClass',
            metadataName: 'Controller'
        }
    ];
    const requiredDependencies = [
        {
            name: 'Helper',
            type: 'ApexClass',
            action: 'DEPLOY',
            selected: true,
            required: true,
            relationship: 'DeploymentReview',
            reason: 'Required by review',
            source: 'DEFAULT'
        }
    ];

    const pkg = deploymentPackageService.generateDeploymentPackage({
        selectedMetadata,
        requiredDependencies,
        selectedTestClasses: []
    });

    assert.deepStrictEqual(Object.keys(pkg).sort(), [
        'dependencies',
        'metadata',
        'summary',
        'testClasses'
    ]);
    assert.deepStrictEqual(
        Object.keys(pkg.metadata[0]).sort(),
        ['artifactResolved', 'filePath', 'metadataName', 'metadataType', 'sourceExists']
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(pkg, 'deploymentPackageProvenance'));
});
