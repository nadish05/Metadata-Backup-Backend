const assert = require('assert');

const { analyze } = require('./deploymentCompatibilityImpact.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function main() {
    await runTest('Flow blocked by excluded CustomField', async () => {
        const result = analyze({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Status__c',
                    reason: 'Formula type change',
                    category: 'FORMULA_TYPE_CHANGE',
                    action: 'AUTO_EXCLUDED'
                }
            ],
            discoveredReferences: [
                {
                    metadataType: 'CustomField',
                    name: 'Session__c.Status__c',
                    sourceMetadata: 'Get_Sessions'
                }
            ],
            resolvedDependencies: []
        });

        assert.strictEqual(result.blockingComponents.length, 1);
        assert.strictEqual(
            result.blockingComponents[0].metadataName,
            'Get_Sessions'
        );
        assert.strictEqual(result.blockingComponents[0].action, 'BLOCKING');
        assert.strictEqual(
            result.blockingComponents[0].blockedBy[0].metadataName,
            'Session__c.Status__c'
        );
        assert.strictEqual(result.blockingSummary.totalBlocking, 1);
    });

    await runTest('FlexiPage blocked by excluded LWC', async () => {
        const result = analyze({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Experience_Record_Page'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [
                {
                    metadataType: 'LightningComponentBundle',
                    metadataName: 'experienceSchedule',
                    reason: 'Incompatible component',
                    category: 'FORMULA_COMPILATION',
                    action: 'AUTO_EXCLUDED'
                }
            ],
            discoveredReferences: [
                {
                    metadataType: 'LightningComponentBundle',
                    name: 'experienceSchedule',
                    sourceMetadata: 'Experience_Record_Page'
                }
            ]
        });

        assert.strictEqual(
            result.blockingComponents[0].metadataName,
            'Experience_Record_Page'
        );
        assert.strictEqual(
            result.blockingComponents[0].blockedBy[0].metadataName,
            'experienceSchedule'
        );
    });

    await runTest('CustomField blocked by excluded CustomField', async () => {
        const result = analyze({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Status_Label__c'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Is_Canceled__c',
                    reason: 'Formula compilation',
                    category: 'FORMULA_COMPILATION',
                    action: 'AUTO_EXCLUDED'
                }
            ],
            discoveredRelationships: [
                {
                    metadataType: 'CustomField',
                    name: 'Booking__c.Is_Canceled__c',
                    sourceMetadata: 'Booking__c',
                    sourceField: 'Status_Label__c',
                    relationship: 'Formula'
                }
            ],
            resolvedDependencies: [
                {
                    type: 'CustomField',
                    name: 'Booking__c.Is_Canceled__c',
                    sourceMetadata: 'Booking__c',
                    sourceField: 'Status_Label__c'
                }
            ]
        });

        assert.strictEqual(result.blockingComponents.length, 1);
        assert.strictEqual(
            result.blockingComponents[0].metadataName,
            'Booking__c.Status_Label__c'
        );
        assert.strictEqual(
            result.blockingComponents[0].blockedBy[0].metadataName,
            'Booking__c.Is_Canceled__c'
        );
    });

    await runTest('Multiple blockedBy entries', async () => {
        const result = analyze({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Booking_Orchestrator'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Status__c',
                    reason: 'type change',
                    category: 'FORMULA_TYPE_CHANGE',
                    action: 'AUTO_EXCLUDED'
                },
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Is_Canceled__c',
                    reason: 'compile',
                    category: 'FORMULA_COMPILATION',
                    action: 'AUTO_EXCLUDED'
                }
            ],
            discoveredReferences: [
                {
                    metadataType: 'CustomField',
                    name: 'Booking__c.Status__c',
                    sourceMetadata: 'Booking_Orchestrator'
                },
                {
                    metadataType: 'CustomField',
                    name: 'Booking__c.Is_Canceled__c',
                    sourceMetadata: 'Booking_Orchestrator'
                }
            ]
        });

        assert.strictEqual(result.blockingComponents.length, 1);
        assert.strictEqual(
            result.blockingComponents[0].blockedBy.length,
            2
        );
        assert.strictEqual(
            result.blockingSummary.blockingByCategory.FORMULA_TYPE_CHANGE,
            1
        );
        assert.strictEqual(
            result.blockingSummary.blockingByCategory.FORMULA_COMPILATION,
            1
        );
        assert.strictEqual(
            result.blockingSummary.blockingByMetadataType.Flow,
            1
        );
    });

    await runTest('No exclusions → no blocking components', async () => {
        const result = analyze({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Booking__c'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [],
            discoveredRelationships: [
                {
                    metadataType: 'CustomObject',
                    name: 'Session__c',
                    sourceMetadata: 'Booking__c'
                }
            ]
        });

        assert.strictEqual(result.blockingComponents.length, 0);
        assert.strictEqual(result.blockingSummary.totalBlocking, 0);
    });
}

main();
