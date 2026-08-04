const assert = require('assert');

const {
    filter,
    AUTO_EXCLUDE_CATEGORIES
} = require('./deploymentCompatibilityFilter.service');

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

function buildPackage(members) {
    const metadata = members.map((member) => ({
        metadataType: member.metadataType || 'CustomField',
        metadataName: member.metadataName
    }));
    const dependencies = [];

    for (const member of members) {
        for (const dep of member.dependencies || []) {
            dependencies.push({
                type: dep.type || 'CustomField',
                name: dep.name
            });
        }
    }

    return {
        metadata,
        dependencies,
        testClasses: [],
        summary: {
            metadataCount: metadata.length,
            dependencyCount: dependencies.length,
            testClassCount: 0,
            totalComponents: metadata.length + dependencies.length
        }
    };
}

function planWith(warnings) {
    return {
        overallStatus: 'WARNING',
        compatibilityWarnings: warnings
    };
}

async function main() {
    await runTest('Formula ↔ Time (FORMULA_TYPE_CHANGE)', async () => {
        const result = filter({
            generatedDeploymentPackage: buildPackage([
                { metadataName: 'Booking__c.Start_Time__c' },
                { metadataName: 'Booking__c.Status__c' }
            ]),
            deploymentCompatibilityPlan: planWith([
                {
                    metadataName: 'Booking__c.Start_Time__c',
                    metadataType: 'CustomField',
                    category: 'FORMULA_TYPE_CHANGE',
                    message:
                        'Cannot update a field to a Formula from Time'
                }
            ])
        });

        assert.strictEqual(result.excludedComponents.length, 1);
        assert.strictEqual(
            result.excludedComponents[0].metadataName,
            'Booking__c.Start_Time__c'
        );
        assert.strictEqual(
            result.excludedComponents[0].action,
            'AUTO_EXCLUDED'
        );
        assert.strictEqual(
            result.excludedComponents[0].category,
            'FORMULA_TYPE_CHANGE'
        );
        assert.ok(
            result.deploymentPackage.metadata.some(
                (item) => item.metadataName === 'Booking__c.Status__c'
            )
        );
        assert.ok(
            !result.deploymentPackage.metadata.some(
                (item) => item.metadataName === 'Booking__c.Start_Time__c'
            )
        );
    });

    await runTest('Formula ↔ Text (FORMULA_COMPILATION)', async () => {
        const result = filter({
            generatedDeploymentPackage: buildPackage([
                { metadataName: 'Booking__c.Status_Label__c' },
                { metadataName: 'Booking__c.Is_Canceled__c' }
            ]),
            deploymentCompatibilityPlan: planWith([
                {
                    metadataName: 'Booking__c.Status_Label__c',
                    metadataType: 'CustomField',
                    category: 'FORMULA_COMPILATION',
                    message: 'Invalid field in formula'
                }
            ])
        });

        assert.strictEqual(result.excludedComponents.length, 1);
        assert.strictEqual(
            result.excludedComponents[0].category,
            'FORMULA_COMPILATION'
        );
        assert.ok(
            result.deploymentPackage.metadata.some(
                (item) => item.metadataName === 'Booking__c.Is_Canceled__c'
            )
        );
    });

    await runTest('Picklist ↔ Formula (PICKLIST_TYPE_CHANGE)', async () => {
        const result = filter({
            generatedDeploymentPackage: buildPackage([
                { metadataName: 'Booking__c.Status__c' },
                { metadataName: 'Session__c.Name_Label__c' }
            ]),
            deploymentCompatibilityPlan: planWith([
                {
                    metadataName: 'Booking__c.Status__c',
                    metadataType: 'CustomField',
                    category: 'PICKLIST_TYPE_CHANGE',
                    message: 'Cannot convert Picklist to Formula'
                }
            ])
        });

        assert.strictEqual(
            result.excludedComponents[0].category,
            'PICKLIST_TYPE_CHANGE'
        );
        assert.ok(
            AUTO_EXCLUDE_CATEGORIES.includes('PICKLIST_TYPE_CHANGE')
        );
        assert.ok(
            !result.deploymentPackage.metadata.some(
                (item) => item.metadataName === 'Booking__c.Status__c'
            )
        );
        assert.ok(
            result.deploymentPackage.metadata.some(
                (item) => item.metadataName === 'Session__c.Name_Label__c'
            )
        );
    });

    await runTest('Compatible metadata remains', async () => {
        const result = filter({
            generatedDeploymentPackage: buildPackage([
                { metadataName: 'Booking__c.Number_of_Guests__c' },
                {
                    metadataName: 'Session__c.Booked_Slots__c',
                    dependencies: [
                        { name: 'Booking__c.Session__c', type: 'CustomField' }
                    ]
                }
            ]),
            deploymentCompatibilityPlan: planWith([
                {
                    metadataName: 'Some_Flow',
                    metadataType: 'Flow',
                    category: 'FLOW_API_VERSION',
                    message: 'API mismatch'
                },
                {
                    metadataName: 'Booking_Page',
                    metadataType: 'FlexiPage',
                    category: 'FLEXIPAGE_DEPENDENCY',
                    message: 'Missing LWC'
                }
            ])
        });

        assert.strictEqual(result.excludedComponents.length, 0);
        assert.strictEqual(result.deploymentPackage.metadata.length, 2);
        assert.strictEqual(result.deploymentPackage.dependencies.length, 1);
        assert.strictEqual(result.compatibilitySummary.totalExcluded, 0);
    });

    await runTest('Summary counts', async () => {
        const result = filter({
            generatedDeploymentPackage: buildPackage([
                { metadataName: 'Booking__c.A__c' },
                { metadataName: 'Booking__c.B__c' },
                {
                    metadataName: 'Booking__c.C__c',
                    dependencies: [
                        { name: 'Booking__c.D__c', type: 'CustomField' }
                    ]
                }
            ]),
            deploymentCompatibilityPlan: planWith([
                {
                    metadataName: 'Booking__c.A__c',
                    metadataType: 'CustomField',
                    category: 'FORMULA_TYPE_CHANGE',
                    message: 'type change'
                },
                {
                    metadataName: 'Booking__c.D__c',
                    metadataType: 'CustomField',
                    category: 'FIELD_TYPE_CHANGE',
                    message: 'field type change'
                },
                {
                    metadataName: 'Booking__c.B__c',
                    metadataType: 'CustomField',
                    category: 'FORMULA_COMPILATION',
                    message: 'compile'
                }
            ])
        });

        assert.strictEqual(result.compatibilitySummary.totalExcluded, 3);
        assert.strictEqual(result.compatibilitySummary.totalRemaining, 1);
        assert.strictEqual(
            result.compatibilitySummary.excludedByCategory.FORMULA_TYPE_CHANGE,
            1
        );
        assert.strictEqual(
            result.compatibilitySummary.excludedByCategory.FIELD_TYPE_CHANGE,
            1
        );
        assert.strictEqual(
            result.compatibilitySummary.excludedByCategory.FORMULA_COMPILATION,
            1
        );
        assert.strictEqual(result.deploymentPackage.summary.metadataCount, 1);
        assert.strictEqual(result.deploymentPackage.summary.dependencyCount, 0);
        assert.strictEqual(
            result.deploymentPackage.metadata[0].metadataName,
            'Booking__c.C__c'
        );
    });
}

main();
