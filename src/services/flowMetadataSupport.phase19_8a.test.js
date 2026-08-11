/**
 * Phase 19.8A — Flow Dependency Validation support.
 * Destination existence for Flow is already green; this phase only adds DepV.
 * Does not change Profile or PermissionSet discovery.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    validateDependencies
} = require('./dependencyValidation.service');
const permissionSetRelationshipDiscoverer = require('./dependencyResolution/discoverers/permissionSetRelationship.discoverer');

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

async function validateFlow(destinationStates, packageShape) {
    return validateDependencies({
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        generatedDeploymentPackage: packageShape || {
            metadata: [
                {
                    metadataType: 'Flow',
                    metadataName: 'MyFlow'
                }
            ],
            dependencies: []
        },
        destinationStates
    });
}

async function main() {
    await runTest('Flow is in SUPPORTED_DEPENDENCY_TYPES + BLOCKED_MESSAGES', () => {
        const source = readDepVSource();

        assert.ok(
            /SUPPORTED_DEPENDENCY_TYPES[\s\S]*?'Flow'/.test(source),
            'SUPPORTED_DEPENDENCY_TYPES must include Flow'
        );
        assert.ok(
            source.includes("Flow: 'Flow not found in destination org.'"),
            'BLOCKED_MESSAGES.Flow must use the required wording'
        );
    });

    await runTest(
        'Dependency Validation treats Flow + EXISTS as supported PASS',
        async () => {
            const result = await validateFlow(
                new Map([['Flow:MyFlow', 'EXISTS']])
            );

            assert.strictEqual(result.overallStatus, 'PASS');
            assert.strictEqual(result.results[0].type, 'Flow');
            assert.strictEqual(result.results[0].name, 'MyFlow');
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
        'Dependency Validation treats Flow + MISSING using inventory semantics',
        async () => {
            const packaged = await validateFlow(
                new Map([['Flow:MyFlow', 'MISSING']])
            );

            assert.strictEqual(packaged.results[0].type, 'Flow');
            assert.strictEqual(packaged.results[0].existsInDestination, false);
            // Packaged members remain PASS (will be deployed) — same as ApexPage/ApexClass.
            assert.strictEqual(packaged.results[0].status, 'PASS');
            assert.strictEqual(
                packaged.results[0].resolution,
                'Will be deployed as part of this deployment package.'
            );
            assert.ok(
                !String(packaged.results[0].message || '').includes(
                    'validation is not supported'
                )
            );

            // Flow as required dependency of another selected member still uses
            // the inventory-driven supported path (not the unsupported fallback).
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
                            type: 'Flow',
                            name: 'MyFlow'
                        }
                    ]
                },
                destinationStates: new Map([['Flow:MyFlow', 'MISSING']])
            });

            const flowRow = missingDependencyOnly.results.find(
                (row) => row.type === 'Flow'
            );

            assert.ok(flowRow);
            assert.strictEqual(flowRow.existsInDestination, false);
            assert.ok(
                !String(flowRow.message || '').includes(
                    'validation is not supported'
                )
            );
            assert.ok(
                readDepVSource().includes(
                    "Flow: 'Flow not found in destination org.'"
                )
            );
        }
    );

    await runTest(
        'Dependency Validation treats Flow + UNKNOWN using inventory semantics',
        async () => {
            const result = await validateFlow(new Map());

            assert.strictEqual(result.results[0].type, 'Flow');
            assert.strictEqual(result.results[0].existsInDestination, false);
            assert.ok(
                !String(result.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Existing ApexClass / CustomObject / CustomField / RecordType / CustomTab / ApexPage DepV unchanged',
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
                        },
                        {
                            metadataType: 'ApexPage',
                            metadataName: 'Weather_Dashboard'
                        }
                    ],
                    dependencies: []
                },
                destinationStates: new Map([
                    ['ApexClass:SessionController', 'EXISTS'],
                    ['CustomObject:Invoice__c', 'EXISTS'],
                    ['CustomField:Invoice__c.Amount__c', 'EXISTS'],
                    ['RecordType:Invoice__c.Retail', 'EXISTS'],
                    ['CustomTab:Gym_Trainer__c', 'EXISTS'],
                    ['ApexPage:Weather_Dashboard', 'EXISTS']
                ])
            });

            assert.strictEqual(result.overallStatus, 'PASS');
            assert.strictEqual(result.results.length, 6);
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

    await runTest(
        'PermissionSet-discovered Flow uses supported DepV path',
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
                            <flowAccesses>
                                <flow>Weather_Sync_Flow</flow>
                                <enabled>false</enabled>
                            </flowAccesses>
                        </PermissionSet>
                    `,
                    depth: 1
                }
            );

            assert.strictEqual(discovery.relationships.length, 1);
            assert.strictEqual(discovery.relationships[0].metadataType, 'Flow');
            assert.strictEqual(
                discovery.relationships[0].relationship,
                'PermissionSetFlowAccess'
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
                    ['Flow:Weather_Sync_Flow', 'EXISTS']
                ])
            });

            const flowRow = result.results.find((row) => row.type === 'Flow');

            assert.ok(flowRow);
            assert.strictEqual(flowRow.existsInDestination, true);
            assert.strictEqual(flowRow.status, 'PASS');
            assert.ok(
                !String(flowRow.message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'Dependency Validation does not introduce direct Salesforce clients',
        () => {
            const source = readDepVSource();

            assert.strictEqual(source.includes('runSoqlQuery'), false);
            assert.strictEqual(source.includes('axios'), false);
            assert.strictEqual(source.includes('getLatestApiVersion'), false);
            assert.strictEqual(
                source.includes('dependencyExistsInDestination'),
                false
            );
            assert.ok(
                source.includes('resolveExistenceFromInventory') ||
                    source.includes('destinationStates'),
                'DepV must remain inventory-driven'
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
