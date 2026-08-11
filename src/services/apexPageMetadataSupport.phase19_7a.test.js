/**
 * Phase 19.7A — ApexPage destination query catalog + Dependency Validation.
 * Inventory EXISTS/MISSING/UNKNOWN integration lives in
 * destinationInventoryBuilder.service.test.js (keeps the builder consumer guard intact).
 * Does not change Profile or PermissionSet discovery.
 */

'use strict';

const assert = require('assert');

const {
    buildExistenceQuery,
    usesToolingApi,
    escapeSoql
} = require('./destinationInventory/destinationExistenceQueries');
const {
    validateDependencies
} = require('./dependencyValidation.service');

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

async function validateApexPage(destinationStates, packageShape) {
    return validateDependencies({
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        generatedDeploymentPackage: packageShape || {
            metadata: [
                {
                    metadataType: 'ApexPage',
                    metadataName: 'Weather_Dashboard'
                }
            ],
            dependencies: []
        },
        destinationStates
    });
}

async function main() {
    await runTest('ApexPage existence query is generated', () => {
        assert.strictEqual(
            buildExistenceQuery('ApexPage', 'Weather_Dashboard'),
            "SELECT Id FROM ApexPage WHERE Name = 'Weather_Dashboard' LIMIT 1"
        );
    });

    await runTest('ApexPage uses Tooling API path', () => {
        assert.strictEqual(usesToolingApi('ApexPage'), true);
        assert.strictEqual(usesToolingApi('ApexClass'), true);
    });

    await runTest('ApexPage names are escaped via escapeSoql', () => {
        const name = "O'Brien_Page";
        assert.strictEqual(
            buildExistenceQuery('ApexPage', name),
            `SELECT Id FROM ApexPage WHERE Name = '${escapeSoql(name)}' LIMIT 1`
        );
        assert.ok(
            buildExistenceQuery('ApexPage', name).includes("O\\'Brien_Page")
        );
    });

    await runTest('Existing ApexClass query behavior remains unchanged', () => {
        assert.strictEqual(
            buildExistenceQuery('ApexClass', 'SessionController'),
            "SELECT Id FROM ApexClass WHERE Name = 'SessionController' LIMIT 1"
        );
        assert.strictEqual(usesToolingApi('ApexClass'), true);
    });

    await runTest(
        'Existing CustomObject / CustomField / RecordType / CustomTab queries unchanged',
        () => {
            assert.ok(
                buildExistenceQuery('CustomObject', 'Invoice__c').includes(
                    'EntityDefinition'
                )
            );
            assert.ok(
                buildExistenceQuery(
                    'CustomField',
                    'Invoice__c.Amount__c'
                ).includes('FieldDefinition')
            );
            assert.ok(
                buildExistenceQuery(
                    'RecordType',
                    'Invoice__c.Standard_Invoice'
                ).includes('RecordType')
            );
            assert.ok(
                buildExistenceQuery('CustomTab', 'Gym_Trainer__c').includes(
                    'TabDefinition'
                )
            );
            assert.strictEqual(usesToolingApi('CustomTab'), false);
        }
    );

    await runTest(
        'Dependency Validation treats ApexPage + EXISTS as supported PASS',
        async () => {
            const result = await validateApexPage(
                new Map([['ApexPage:Weather_Dashboard', 'EXISTS']])
            );

            assert.strictEqual(result.overallStatus, 'PASS');
            assert.strictEqual(result.results[0].type, 'ApexPage');
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
        'Dependency Validation treats ApexPage + MISSING using inventory semantics',
        async () => {
            const packaged = await validateApexPage(
                new Map([['ApexPage:Weather_Dashboard', 'MISSING']])
            );

            assert.strictEqual(packaged.results[0].type, 'ApexPage');
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
                            metadataType: 'Profile',
                            metadataName: 'Custom_Admin'
                        }
                    ],
                    dependencies: [
                        {
                            type: 'ApexPage',
                            name: 'Weather_Dashboard'
                        }
                    ]
                },
                destinationStates: new Map([
                    ['ApexPage:Weather_Dashboard', 'MISSING']
                ])
            });

            const pageRow = missingDependencyOnly.results.find(
                (row) => row.type === 'ApexPage'
            );

            assert.ok(pageRow);
            assert.strictEqual(pageRow.existsInDestination, false);
            assert.ok(
                !String(pageRow.message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Dependency Validation treats ApexPage + UNKNOWN using inventory semantics',
        async () => {
            const result = await validateApexPage(new Map());

            assert.strictEqual(result.results[0].type, 'ApexPage');
            assert.strictEqual(result.results[0].existsInDestination, false);
            assert.ok(
                !String(result.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Existing ApexClass / CustomObject / CustomField / RecordType / CustomTab DepV unchanged',
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
                            metadataType: 'CustomField',
                            metadataName: 'Invoice__c.Amount__c'
                        },
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Invoice__c.Retail'
                        },
                        {
                            metadataType: 'CustomTab',
                            metadataName: 'Gym_Trainer__c'
                        }
                    ],
                    dependencies: []
                },
                destinationStates: new Map([
                    ['ApexClass:SessionController', 'EXISTS'],
                    ['CustomObject:Invoice__c', 'EXISTS'],
                    ['CustomField:Invoice__c.Amount__c', 'EXISTS'],
                    ['RecordType:Invoice__c.Retail', 'EXISTS'],
                    ['CustomTab:Gym_Trainer__c', 'EXISTS']
                ])
            });

            assert.strictEqual(result.overallStatus, 'PASS');
            assert.strictEqual(result.results.length, 5);
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
            assert.strictEqual(
                result.results[0].resolution,
                'Will be deployed as part of this deployment package.'
            );
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
