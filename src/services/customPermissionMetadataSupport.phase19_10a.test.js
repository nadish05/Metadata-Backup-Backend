/**
 * Phase 19.10A — CustomPermission metadata rule, Dest query catalog, DepV.
 * Inventory EXISTS/MISSING/UNKNOWN integration lives in
 * destinationInventoryBuilder.service.test.js.
 * Does not change Profile or PermissionSet discovery.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    METADATA_KINDS,
    getMetadataTypeRule
} = require('../config/metadataTypes');
const {
    getArtifactResolver
} = require('./repositoryArtifacts/artifactResolverRegistry');
const {
    enrichNode
} = require('./repositoryArtifacts/artifactResolution.service');
const {
    buildExistenceQuery,
    usesToolingApi,
    escapeSoql,
    parseCustomPermissionMember
} = require('./destinationInventory/destinationExistenceQueries');
const {
    validateDependencies
} = require('./dependencyValidation.service');
const {
    classifyDependency,
    CLASSIFICATIONS
} = require('./dependencyResolution/dependencyClassification.service');
const permissionSetRelationshipDiscoverer = require('./dependencyResolution/discoverers/permissionSetRelationship.discoverer');

const CUSTOM_PERMISSION_PATH =
    'force-app/main/default/customPermissions/MyPermission.customPermission-meta.xml';
const NAMESPACED_PERMISSION_PATH =
    'force-app/main/default/customPermissions/Namespace__MyPermission.customPermission-meta.xml';
const PERMISSION_SET_PATH =
    'force-app/main/default/permissionsets/Subscription_Access.permissionset-meta.xml';

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function readDepVSource() {
    return fs.readFileSync(
        path.join(__dirname, 'dependencyValidation.service.js'),
        'utf8'
    );
}

function readPermissionSetDiscovererSource() {
    return fs.readFileSync(
        path.join(
            __dirname,
            'dependencyResolution/discoverers/permissionSetRelationship.discoverer.js'
        ),
        'utf8'
    );
}

async function validateCustomPermission(destinationStates, packageShape) {
    return validateDependencies({
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        generatedDeploymentPackage: packageShape || {
            metadata: [
                {
                    metadataType: 'CustomPermission',
                    metadataName: 'MyPermission'
                }
            ],
            dependencies: []
        },
        destinationStates
    });
}

async function main() {
    await runTest('CustomPermission metadata rule uses customPermissions format', () => {
        const rule = getMetadataTypeRule('CustomPermission');

        assert.ok(rule);
        assert.strictEqual(rule.kind, METADATA_KINDS.FILE);
        assert.strictEqual(rule.folder, 'customPermissions');
        assert.strictEqual(rule.extension, '.customPermission-meta.xml');
        assert.strictEqual(rule.requiresMetaXml, false);
        assert.ok(rule.memberNamePattern.test('MyPermission'));
        assert.ok(rule.memberNamePattern.test('My_Custom_Permission'));
        assert.ok(rule.memberNamePattern.test('Namespace__MyPermission'));
        assert.strictEqual(rule.memberNamePattern.test('Bad Permission'), false);
        assert.strictEqual(
            getArtifactResolver('CustomPermission').id,
            'GenericFileArtifactResolver'
        );
    });

    await runTest(
        'CustomPermission classifies as DEPLOYABLE_METADATA via metadata rule',
        () => {
            const result = classifyDependency({
                type: 'CustomPermission',
                name: 'MyPermission'
            });

            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(result.packageable, true);
            assert.strictEqual(result.artifactRequired, true);
        }
    );

    await runTest(
        'CustomPermission resolves from customPermissions folder via generic resolver',
        () => {
            const wrongFolder =
                'force-app/main/default/other/MyPermission.customPermission-meta.xml';
            const enriched = enrichNode(
                {
                    metadataType: 'CustomPermission',
                    name: 'MyPermission'
                },
                [wrongFolder, CUSTOM_PERMISSION_PATH]
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.filePath, CUSTOM_PERMISSION_PATH);
        }
    );

    await runTest('namespaced CustomPermission artifact basename resolves', () => {
        const enriched = enrichNode(
            {
                metadataType: 'CustomPermission',
                name: 'Namespace__MyPermission'
            },
            [NAMESPACED_PERMISSION_PATH]
        );

        assert.strictEqual(enriched.artifactResolved, true);
        assert.strictEqual(enriched.filePath, NAMESPACED_PERMISSION_PATH);
    });

    await runTest('missing CustomPermission remains unresolved', () => {
        const enriched = enrichNode(
            {
                metadataType: 'CustomPermission',
                name: 'Missing_Permission'
            },
            [CUSTOM_PERMISSION_PATH]
        );

        assert.strictEqual(enriched.artifactResolved, false);
    });

    await runTest('malformed CustomPermission name is ignored by resolver', () => {
        const enriched = enrichNode(
            {
                metadataType: 'CustomPermission',
                name: 'Bad Permission'
            },
            [
                'force-app/main/default/customPermissions/Bad Permission.customPermission-meta.xml'
            ]
        );

        assert.strictEqual(enriched.artifactResolved, false);
    });

    await runTest('CustomPermission uses REST, not Tooling', () => {
        assert.strictEqual(usesToolingApi('CustomPermission'), false);
    });

    await runTest('unnamespaced CustomPermission existence query', () => {
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', 'MyPermission'),
            'SELECT Id FROM CustomPermission WHERE DeveloperName = \'MyPermission\' AND NamespacePrefix = null LIMIT 1'
        );
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', 'My_Custom_Permission'),
            'SELECT Id FROM CustomPermission WHERE DeveloperName = \'My_Custom_Permission\' AND NamespacePrefix = null LIMIT 1'
        );
    });

    await runTest('namespaced CustomPermission existence query', () => {
        assert.deepStrictEqual(
            parseCustomPermissionMember('Namespace__MyPermission'),
            {
                developerName: 'MyPermission',
                namespacePrefix: 'Namespace'
            }
        );
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', 'Namespace__MyPermission'),
            "SELECT Id FROM CustomPermission WHERE DeveloperName = 'MyPermission' AND NamespacePrefix = 'Namespace' LIMIT 1"
        );
    });

    await runTest('CustomPermission names are escaped via escapeSoql', () => {
        // Apostrophe is not a valid CustomPermission API name → no SOQL built.
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', "O'Brien_Permission"),
            null
        );

        // Valid names still pass through escapeSoql in the query builder.
        const soql = buildExistenceQuery(
            'CustomPermission',
            'My_Custom_Permission'
        );
        assert.ok(soql.includes(escapeSoql('My_Custom_Permission')));
        assert.strictEqual(
            soql,
            "SELECT Id FROM CustomPermission WHERE DeveloperName = 'My_Custom_Permission' AND NamespacePrefix = null LIMIT 1"
        );

        const namespaced = buildExistenceQuery(
            'CustomPermission',
            'Ns__My_Permission'
        );
        assert.ok(namespaced.includes(escapeSoql('My_Permission')));
        assert.ok(namespaced.includes(escapeSoql('Ns')));
    });

    await runTest('invalid/unsafe CustomPermission names yield null query', () => {
        assert.strictEqual(buildExistenceQuery('CustomPermission', ''), null);
        assert.strictEqual(buildExistenceQuery('CustomPermission', '   '), null);
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', 'Bad Permission'),
            null
        );
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', 'Bad-Permission'),
            null
        );
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', '1BadPermission'),
            null
        );
        assert.strictEqual(
            buildExistenceQuery('CustomPermission', 'A__B__C'),
            null
        );
        assert.strictEqual(parseCustomPermissionMember('A__'), null);
        assert.strictEqual(parseCustomPermissionMember('__B'), null);
    });

    await runTest('Existing ApexClass / Flow / ApexPage / CustomApplication queries unchanged', () => {
        assert.strictEqual(
            buildExistenceQuery('ApexClass', 'SessionController'),
            "SELECT Id FROM ApexClass WHERE Name = 'SessionController' LIMIT 1"
        );
        assert.ok(
            buildExistenceQuery('Flow', 'MyFlow').includes('FlowDefinition')
        );
        assert.ok(
            buildExistenceQuery('ApexPage', 'Weather_Dashboard').includes(
                'ApexPage'
            )
        );
        assert.ok(
            buildExistenceQuery('CustomApplication', 'My_Custom_App').includes(
                'FullName'
            )
        );
        assert.strictEqual(usesToolingApi('CustomApplication'), true);
        assert.strictEqual(usesToolingApi('ApexPage'), true);
        assert.strictEqual(usesToolingApi('Flow'), true);
    });

    await runTest(
        'CustomPermission is in SUPPORTED_DEPENDENCY_TYPES + BLOCKED_MESSAGES',
        () => {
            const source = readDepVSource();

            assert.ok(
                /SUPPORTED_DEPENDENCY_TYPES[\s\S]*?'CustomPermission'/.test(
                    source
                )
            );
            assert.ok(
                source.includes(
                    "CustomPermission: 'Custom Permission not found in destination org.'"
                )
            );
        }
    );

    await runTest(
        'Dependency Validation treats CustomPermission + EXISTS as supported PASS',
        async () => {
            const result = await validateCustomPermission(
                new Map([['CustomPermission:MyPermission', 'EXISTS']])
            );

            assert.strictEqual(result.overallStatus, 'PASS');
            assert.strictEqual(result.results[0].type, 'CustomPermission');
            assert.strictEqual(result.results[0].status, 'PASS');
            assert.strictEqual(result.results[0].existsInDestination, true);
            assert.ok(
                !String(result.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Dependency Validation treats CustomPermission + MISSING using inventory semantics',
        async () => {
            const packaged = await validateCustomPermission(
                new Map([['CustomPermission:MyPermission', 'MISSING']])
            );

            assert.strictEqual(packaged.results[0].type, 'CustomPermission');
            assert.strictEqual(packaged.results[0].existsInDestination, false);
            assert.strictEqual(packaged.results[0].status, 'PASS');
            assert.ok(
                !String(packaged.results[0].message || '').includes(
                    'validation is not supported'
                )
            );

            const missingDependencyOnly = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'Subscription_Access'
                        }
                    ],
                    dependencies: [
                        {
                            type: 'CustomPermission',
                            name: 'MyPermission'
                        }
                    ]
                },
                destinationStates: new Map([
                    ['CustomPermission:MyPermission', 'MISSING']
                ])
            });

            const row = missingDependencyOnly.results.find(
                (item) => item.type === 'CustomPermission'
            );

            assert.ok(row);
            assert.strictEqual(row.existsInDestination, false);
            assert.ok(
                !String(row.message || '').includes(
                    'validation is not supported'
                )
            );
            assert.notStrictEqual(
                row.message,
                'CustomPermission validation is not supported.'
            );
        }
    );

    await runTest(
        'Dependency Validation treats CustomPermission + UNKNOWN using inventory semantics',
        async () => {
            const result = await validateCustomPermission(
                new Map([['CustomPermission:MyPermission', 'UNKNOWN']])
            );

            assert.strictEqual(result.results[0].type, 'CustomPermission');
            assert.ok(
                !String(result.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Existing ApexClass / CustomObject / ApexPage / Flow / CustomApplication DepV unchanged',
        async () => {
            const result = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'SessionController'
                        },
                        {
                            metadataType: 'ApexPage',
                            metadataName: 'Weather_Dashboard'
                        },
                        {
                            metadataType: 'CustomObject',
                            metadataName: 'Invoice__c'
                        },
                        {
                            metadataType: 'Flow',
                            metadataName: 'MyFlow'
                        },
                        {
                            metadataType: 'CustomApplication',
                            metadataName: 'My_Custom_App'
                        }
                    ],
                    dependencies: []
                },
                destinationStates: new Map([
                    ['ApexClass:SessionController', 'EXISTS'],
                    ['ApexPage:Weather_Dashboard', 'EXISTS'],
                    ['CustomObject:Invoice__c', 'EXISTS'],
                    ['Flow:MyFlow', 'EXISTS'],
                    ['CustomApplication:My_Custom_App', 'EXISTS']
                ])
            });

            assert.strictEqual(result.overallStatus, 'PASS');
        }
    );

    await runTest(
        'PermissionSet-discovered CustomPermission uses supported DepV path',
        async () => {
            const discovery = await permissionSetRelationshipDiscoverer.discover(
                {
                    selectedMetadata: [
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'Subscription_Access',
                            filePath: PERMISSION_SET_PATH
                        }
                    ],
                    repoFiles: [PERMISSION_SET_PATH],
                    readRepoFile: async () => `
                        <PermissionSet>
                            <customPermissions>
                                <name>Can_Approve_Refund</name>
                                <enabled>false</enabled>
                            </customPermissions>
                        </PermissionSet>
                    `,
                    depth: 1
                }
            );

            const customPermission = discovery.relationships.find(
                (item) => item.metadataType === 'CustomPermission'
            );

            assert.ok(customPermission);
            assert.strictEqual(customPermission.name, 'Can_Approve_Refund');
            assert.strictEqual(
                customPermission.relationship,
                'PermissionSetCustomPermission'
            );

            const result = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'Subscription_Access'
                        }
                    ],
                    dependencies: [
                        {
                            type: customPermission.metadataType,
                            name: customPermission.name
                        }
                    ]
                },
                destinationStates: new Map([
                    ['CustomPermission:Can_Approve_Refund', 'EXISTS']
                ])
            });

            const row = result.results.find(
                (item) => item.type === 'CustomPermission'
            );

            assert.ok(row);
            assert.strictEqual(row.status, 'PASS');
            assert.ok(
                !String(row.message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest('PermissionSet discoverer source remains unchanged', () => {
        const source = readPermissionSetDiscovererSource();

        assert.ok(source.includes('PermissionSetCustomPermission'));
        assert.ok(source.includes("discoveryMethod: 'customPermissions'"));
        assert.ok(!source.includes('ProfileCustomPermission'));
    });

    await runTest(
        'Dependency Validation remains inventory-driven (no direct Salesforce client)',
        () => {
            const source = readDepVSource();

            assert.ok(!source.includes('axios'));
            assert.ok(!source.includes('jsforce'));
            assert.ok(source.includes('resolveExistenceFromInventory'));
        }
    );

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
