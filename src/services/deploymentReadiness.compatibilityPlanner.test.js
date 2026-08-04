const assert = require('assert');

const {
    planCompatibilityDeploymentReadiness
} = require('./deploymentReadiness.service');

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
    await runTest('Fully deployable package', async () => {
        const result = planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Booking__c'
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Session__c'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [],
            blockingComponents: [],
            compatibilitySummary: { totalExcluded: 0 },
            blockingSummary: { totalBlocking: 0 },
            totalWarnings: 0
        });

        assert.strictEqual(result.readyForDeployment, true);
        assert.strictEqual(result.deployableComponents.length, 2);
        assert.strictEqual(result.summary.totalExcluded, 0);
        assert.strictEqual(result.summary.totalBlocking, 0);
    });

    await runTest('Package with exclusions only', async () => {
        const result = planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Booking__c'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Status__c',
                    category: 'FORMULA_TYPE_CHANGE',
                    action: 'AUTO_EXCLUDED'
                }
            ],
            blockingComponents: [],
            compatibilitySummary: { totalExcluded: 1 },
            blockingSummary: { totalBlocking: 0 },
            totalWarnings: 1
        });

        assert.strictEqual(result.readyForDeployment, true);
        assert.strictEqual(result.excludedComponents.length, 1);
        assert.strictEqual(result.blockingComponents.length, 0);
        assert.strictEqual(result.summary.totalDeployable, 1);
        assert.strictEqual(result.summary.excluded, 1);
    });

    await runTest('Package with exclusions + blocking', async () => {
        const result = planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    },
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c'
                    }
                ],
                dependencies: []
            },
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Status__c',
                    category: 'FORMULA_TYPE_CHANGE',
                    action: 'AUTO_EXCLUDED'
                }
            ],
            blockingComponents: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Get_Sessions',
                    action: 'BLOCKING',
                    blockedBy: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Status__c'
                        }
                    ]
                }
            ],
            compatibilitySummary: { totalExcluded: 1 },
            blockingSummary: { totalBlocking: 1 },
            totalWarnings: 2
        });

        assert.strictEqual(result.readyForDeployment, false);
        assert.strictEqual(result.blockingComponents.length, 1);
        assert.strictEqual(result.deployableComponents.length, 1);
        assert.strictEqual(
            result.deployableComponents[0].metadataName,
            'Session__c'
        );
        assert.strictEqual(result.summary.totalBlocking, 1);
        assert.strictEqual(result.summary.blocking, 1);
    });

    await runTest('Empty package', async () => {
        const result = planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: {
                metadata: [],
                dependencies: []
            },
            excludedComponents: [],
            blockingComponents: [],
            compatibilitySummary: { totalExcluded: 0 },
            blockingSummary: { totalBlocking: 0 },
            totalWarnings: 0
        });

        assert.strictEqual(result.readyForDeployment, true);
        assert.strictEqual(result.deployableComponents.length, 0);
        assert.strictEqual(result.summary.totalDeployable, 0);
    });

    await runTest('Summary counts', async () => {
        const result = planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: {
                metadata: [
                    { metadataType: 'CustomField', metadataName: 'A__c.X__c' },
                    { metadataType: 'CustomField', metadataName: 'A__c.Y__c' },
                    { metadataType: 'Flow', metadataName: 'Flow_A' }
                ],
                dependencies: [
                    { type: 'CustomField', name: 'A__c.Z__c' }
                ]
            },
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'A__c.Bad__c',
                    action: 'AUTO_EXCLUDED'
                },
                {
                    metadataType: 'CustomField',
                    metadataName: 'A__c.Worse__c',
                    action: 'AUTO_EXCLUDED'
                }
            ],
            blockingComponents: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Flow_A',
                    action: 'BLOCKING',
                    blockedBy: []
                }
            ],
            compatibilitySummary: { totalExcluded: 2 },
            blockingSummary: { totalBlocking: 1 },
            totalWarnings: 4
        });

        assert.strictEqual(result.summary.totalDeployable, 3);
        assert.strictEqual(result.summary.totalExcluded, 2);
        assert.strictEqual(result.summary.totalBlocking, 1);
        assert.strictEqual(result.summary.totalWarnings, 4);
        assert.strictEqual(result.summary.deployable, 3);
        assert.strictEqual(result.summary.excluded, 2);
        assert.strictEqual(result.summary.blocking, 1);
        assert.strictEqual(result.summary.warnings, 4);
        assert.strictEqual(result.readyForDeployment, false);
    });
}

main();
