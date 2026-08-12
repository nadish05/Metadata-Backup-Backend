/**
 * Phase 19.9A — CustomApplication metadata rule, Dest query catalog, DepV.
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
    escapeSoql
} = require('./destinationInventory/destinationExistenceQueries');
const {
    validateDependencies
} = require('./dependencyValidation.service');
const permissionSetRelationshipDiscoverer = require('./dependencyResolution/discoverers/permissionSetRelationship.discoverer');

const CUSTOM_APP_PATH =
    'force-app/main/default/applications/My_Custom_App.app-meta.xml';
const STANDARD_APP_PATH =
    'force-app/main/default/applications/standard__Sales.app-meta.xml';
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

async function validateCustomApplication(destinationStates, packageShape) {
    return validateDependencies({
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        generatedDeploymentPackage: packageShape || {
            metadata: [
                {
                    metadataType: 'CustomApplication',
                    metadataName: 'My_Custom_App'
                }
            ],
            dependencies: []
        },
        destinationStates
    });
}

async function main() {
    await runTest('CustomApplication metadata rule uses applications format', () => {
        const rule = getMetadataTypeRule('CustomApplication');

        assert.ok(rule);
        assert.strictEqual(rule.kind, METADATA_KINDS.FILE);
        assert.strictEqual(rule.folder, 'applications');
        assert.strictEqual(rule.extension, '.app-meta.xml');
        assert.strictEqual(rule.requiresMetaXml, false);
        assert.ok(rule.memberNamePattern.test('My_Custom_App'));
        assert.ok(rule.memberNamePattern.test('standard__Sales'));
        assert.strictEqual(rule.memberNamePattern.test('Bad App'), false);
        assert.strictEqual(
            getArtifactResolver('CustomApplication').id,
            'GenericFileArtifactResolver'
        );
    });

    await runTest(
        'CustomApplication resolves from applications folder via generic resolver',
        () => {
            const wrongFolder =
                'force-app/main/default/other/My_Custom_App.app-meta.xml';
            const enriched = enrichNode(
                {
                    metadataType: 'CustomApplication',
                    name: 'My_Custom_App'
                },
                [wrongFolder, CUSTOM_APP_PATH]
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.filePath, CUSTOM_APP_PATH);
        }
    );

    await runTest(
        'standard__Sales resolves from applications folder',
        () => {
            const enriched = enrichNode(
                {
                    metadataType: 'CustomApplication',
                    name: 'standard__Sales'
                },
                [STANDARD_APP_PATH]
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.filePath, STANDARD_APP_PATH);
        }
    );

    await runTest('missing CustomApplication remains unresolved', () => {
        const enriched = enrichNode(
            {
                metadataType: 'CustomApplication',
                name: 'Missing_App'
            },
            [CUSTOM_APP_PATH]
        );

        assert.strictEqual(enriched.artifactResolved, false);
    });

    await runTest('malformed CustomApplication name is ignored by resolver', () => {
        const enriched = enrichNode(
            {
                metadataType: 'CustomApplication',
                name: 'Bad App'
            },
            ['force-app/main/default/applications/Bad App.app-meta.xml']
        );

        assert.strictEqual(enriched.artifactResolved, false);
    });

    await runTest('CustomApplication existence query uses Tooling FullName', () => {
        assert.strictEqual(usesToolingApi('CustomApplication'), true);
        assert.strictEqual(
            buildExistenceQuery('CustomApplication', 'My_Custom_App'),
            "SELECT Id FROM CustomApplication WHERE FullName = 'My_Custom_App' LIMIT 1"
        );
        assert.strictEqual(
            buildExistenceQuery('CustomApplication', 'standard__Sales'),
            "SELECT Id FROM CustomApplication WHERE FullName = 'standard__Sales' LIMIT 1"
        );
    });

    await runTest('CustomApplication names are escaped via escapeSoql', () => {
        const name = "O'Brien_App";
        assert.strictEqual(
            buildExistenceQuery('CustomApplication', name),
            `SELECT Id FROM CustomApplication WHERE FullName = '${escapeSoql(name)}' LIMIT 1`
        );
        assert.ok(
            buildExistenceQuery('CustomApplication', name).includes(
                "O\\'Brien_App"
            )
        );
    });

    await runTest('Existing ApexClass / Flow / ApexPage queries unchanged', () => {
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
    });

    await runTest(
        'CustomApplication is in SUPPORTED_DEPENDENCY_TYPES + BLOCKED_MESSAGES',
        () => {
            const source = readDepVSource();

            assert.ok(
                /SUPPORTED_DEPENDENCY_TYPES[\s\S]*?'CustomApplication'/.test(
                    source
                )
            );
            assert.ok(
                source.includes(
                    "CustomApplication: 'Custom Application not found in destination org.'"
                )
            );
        }
    );

    await runTest(
        'Dependency Validation treats CustomApplication + EXISTS as supported PASS',
        async () => {
            const result = await validateCustomApplication(
                new Map([['CustomApplication:My_Custom_App', 'EXISTS']])
            );

            assert.strictEqual(result.overallStatus, 'PASS');
            assert.strictEqual(result.results[0].type, 'CustomApplication');
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
        'Dependency Validation treats CustomApplication + MISSING using inventory semantics',
        async () => {
            const packaged = await validateCustomApplication(
                new Map([['CustomApplication:My_Custom_App', 'MISSING']])
            );

            assert.strictEqual(packaged.results[0].type, 'CustomApplication');
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
                            type: 'CustomApplication',
                            name: 'My_Custom_App'
                        }
                    ]
                },
                destinationStates: new Map([
                    ['CustomApplication:My_Custom_App', 'MISSING']
                ])
            });

            const appRow = missingDependencyOnly.results.find(
                (row) => row.type === 'CustomApplication'
            );

            assert.ok(appRow);
            assert.strictEqual(appRow.existsInDestination, false);
            assert.ok(
                !String(appRow.message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Dependency Validation treats CustomApplication + UNKNOWN using inventory semantics',
        async () => {
            const result = await validateCustomApplication(new Map());

            assert.strictEqual(result.results[0].type, 'CustomApplication');
            assert.strictEqual(result.results[0].existsInDestination, false);
            assert.ok(
                !String(result.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'standard__Sales CustomApplication uses supported DepV path',
        async () => {
            const result = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'CustomApplication',
                            metadataName: 'standard__Sales'
                        }
                    ],
                    dependencies: []
                },
                destinationStates: new Map([
                    ['CustomApplication:standard__Sales', 'EXISTS']
                ])
            });

            assert.strictEqual(result.results[0].type, 'CustomApplication');
            assert.strictEqual(result.results[0].name, 'standard__Sales');
            assert.strictEqual(result.results[0].existsInDestination, true);
            assert.ok(
                !String(result.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Existing ApexClass / CustomObject / ApexPage / Flow DepV unchanged',
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
                            metadataType: 'CustomObject',
                            metadataName: 'Invoice__c'
                        },
                        {
                            metadataType: 'ApexPage',
                            metadataName: 'Weather_Dashboard'
                        },
                        {
                            metadataType: 'Flow',
                            metadataName: 'MyFlow'
                        }
                    ],
                    dependencies: []
                },
                destinationStates: new Map([
                    ['ApexClass:SessionController', 'EXISTS'],
                    ['CustomObject:Invoice__c', 'EXISTS'],
                    ['ApexPage:Weather_Dashboard', 'EXISTS'],
                    ['Flow:MyFlow', 'EXISTS']
                ])
            });

            assert.strictEqual(result.overallStatus, 'PASS');
            assert.strictEqual(result.results.length, 4);
            assert.ok(
                result.results.every(
                    (row) =>
                        row.status === 'PASS' && row.existsInDestination === true
                )
            );
        }
    );

    await runTest(
        'Unsupported metadata types remain unsupported',
        async () => {
            const result = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'ExternalCredential',
                            metadataName: 'Weather'
                        }
                    ],
                    dependencies: []
                },
                destinationStates: new Map([
                    ['ExternalCredential:Weather', 'EXISTS']
                ])
            });

            assert.strictEqual(result.results[0].type, 'ExternalCredential');
            assert.strictEqual(result.results[0].existsInDestination, false);
            assert.strictEqual(result.results[0].status, 'PASS');
        }
    );

    await runTest(
        'PermissionSet-discovered CustomApplication uses supported DepV path',
        async () => {
            const discovery =
                await permissionSetRelationshipDiscoverer.discover({
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
                            <applicationVisibilities>
                                <application>My_Custom_App</application>
                                <visible>false</visible>
                            </applicationVisibilities>
                        </PermissionSet>
                    `,
                    depth: 1
                });

            assert.strictEqual(discovery.relationships.length, 1);
            assert.strictEqual(
                discovery.relationships[0].metadataType,
                'CustomApplication'
            );
            assert.strictEqual(
                discovery.relationships[0].relationship,
                'PermissionSetApplicationVisibility'
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
                    dependencies: discovery.relationships.map((item) => ({
                        type: item.metadataType,
                        name: item.name
                    }))
                },
                destinationStates: new Map([
                    ['CustomApplication:My_Custom_App', 'EXISTS']
                ])
            });

            const appRow = result.results.find(
                (row) => row.type === 'CustomApplication'
            );

            assert.ok(appRow);
            assert.strictEqual(appRow.existsInDestination, true);
            assert.strictEqual(appRow.status, 'PASS');
            assert.ok(
                !String(appRow.message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Dependency Validation remains inventory-driven (no direct Salesforce client)',
        () => {
            const source = readDepVSource();

            assert.strictEqual(source.includes('runSoqlQuery'), false);
            assert.strictEqual(source.includes('axios'), false);
            assert.ok(source.includes('destinationStates'));
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
