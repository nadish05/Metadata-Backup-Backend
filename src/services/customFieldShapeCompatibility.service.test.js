'use strict';

const assert = require('assert');

const {
    analyzeCustomFieldShapeCompatibilityConflicts,
    SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR
} = require('./customFieldShapeCompatibility.service');
const {
    analyzeDeploymentCompatibilityPlan,
    mapExistingFindingWarnings,
    CATEGORIES
} = require('./deploymentCompatibility.service');
const { filter } = require('./deploymentCompatibilityFilter.service');
const failureClassificationService = require('./deploymentFailureClassification/deploymentFailureClassification.service');
const { classifyDeploymentFailures } = failureClassificationService;
const FAILURE_CATEGORIES = failureClassificationService.CATEGORIES;

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

function buildPackage(fieldNames) {
    return {
        metadata: fieldNames.map((metadataName) => ({
            metadataType: 'CustomField',
            metadataName
        })),
        dependencies: []
    };
}

function sourceShape(metadataName, attrs) {
    const map = new Map();
    map.set(`CustomField:${metadataName}`, {
        metadataType: 'CustomField',
        metadataName,
        attributes: attrs,
        warning: null
    });
    return map;
}

function destinationShapeIndex(entries) {
    const shapes = new Map();
    for (const [metadataName, attributes] of Object.entries(entries)) {
        shapes.set(`CustomField:${metadataName}`, {
            metadataType: 'CustomField',
            metadataName,
            found: true,
            queried: true,
            attributes
        });
    }
    return { shapes };
}

async function main() {
    await runTest(
        '1. Source non-formula / destination formula — matching underlying types',
        () => {
            const metadataName = 'Obj__c.End_Time__c';
            const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
                generatedDeploymentPackage: buildPackage([metadataName]),
                sourceShapeIndex: sourceShape(metadataName, {
                    type: 'time',
                    mdapiType: 'Time',
                    calculated: false,
                    label: 'End Time'
                }),
                destinationShapeIndex: destinationShapeIndex({
                    [metadataName]: {
                        type: 'time',
                        calculated: true,
                        label: 'End Time'
                    }
                })
            });

            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].category, 'FORMULA_TYPE_CHANGE');
            assert.strictEqual(warnings[0].autoExclude, false);
            assert.ok(warnings[0].message.includes('Time'));
            assert.ok(
                warnings[0].message.includes(SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR)
            );
            assert.strictEqual(
                warnings[0].expectedSalesforceError,
                SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR
            );
        }
    );

    await runTest(
        '2. Source non-formula / destination formula — differing underlying types',
        () => {
            const metadataName = 'Obj__c.Status__c';
            const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
                generatedDeploymentPackage: buildPackage([metadataName]),
                sourceShapeIndex: sourceShape(metadataName, {
                    type: 'picklist',
                    mdapiType: 'Picklist',
                    calculated: false,
                    label: 'Status'
                }),
                destinationShapeIndex: destinationShapeIndex({
                    [metadataName]: {
                        type: 'string',
                        calculated: true,
                        label: 'Status'
                    }
                })
            });

            assert.strictEqual(warnings.length, 1);
            assert.ok(warnings[0].message.includes('Picklist'));
            assert.ok(warnings[0].message.includes('string'));
            assert.ok(warnings[0].conflictFacts.source.calculated === false);
            assert.ok(warnings[0].conflictFacts.destination.calculated === true);
        }
    );

    await runTest('3. Source formula / destination non-formula', () => {
        const metadataName = 'Obj__c.Score__c';
        const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
            generatedDeploymentPackage: buildPackage([metadataName]),
            sourceShapeIndex: sourceShape(metadataName, {
                type: 'double',
                mdapiType: 'Number',
                calculated: true,
                label: 'Score'
            }),
            destinationShapeIndex: destinationShapeIndex({
                [metadataName]: {
                    type: 'double',
                    calculated: false,
                    label: 'Score'
                }
            })
        });

        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].message.includes('formula'));
        assert.strictEqual(warnings[0].expectedSalesforceError, null);
    });

    await runTest('4. Both sides formula — no conflict', () => {
        const metadataName = 'Obj__c.Amount__c';
        const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
            generatedDeploymentPackage: buildPackage([metadataName]),
            sourceShapeIndex: sourceShape(metadataName, {
                type: 'currency',
                mdapiType: 'Currency',
                calculated: true,
                label: 'Amount'
            }),
            destinationShapeIndex: destinationShapeIndex({
                [metadataName]: {
                    type: 'currency',
                    calculated: true,
                    label: 'Amount'
                }
            })
        });

        assert.strictEqual(warnings.length, 0);
    });

    await runTest('5. Both sides compatible non-formula', () => {
        const metadataName = 'Obj__c.Code__c';
        const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
            generatedDeploymentPackage: buildPackage([metadataName]),
            sourceShapeIndex: sourceShape(metadataName, {
                type: 'string',
                mdapiType: 'Text',
                calculated: false,
                label: 'Code'
            }),
            destinationShapeIndex: destinationShapeIndex({
                [metadataName]: {
                    type: 'string',
                    calculated: false,
                    label: 'Code'
                }
            })
        });

        assert.strictEqual(warnings.length, 0);
    });

    await runTest('6. Missing source shape — no confirmed conflict', () => {
        const metadataName = 'Obj__c.Gap__c';
        const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
            generatedDeploymentPackage: buildPackage([metadataName]),
            sourceShapeIndex: new Map(),
            destinationShapeIndex: destinationShapeIndex({
                [metadataName]: {
                    type: 'string',
                    calculated: true,
                    label: 'Gap'
                }
            })
        });

        assert.strictEqual(warnings.length, 0);
    });

    await runTest('7. Missing destination shape — no confirmed conflict', () => {
        const metadataName = 'Obj__c.Gap__c';
        const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
            generatedDeploymentPackage: buildPackage([metadataName]),
            sourceShapeIndex: sourceShape(metadataName, {
                type: 'string',
                mdapiType: 'Text',
                calculated: false,
                label: 'Gap'
            }),
            destinationShapeIndex: { shapes: new Map() }
        });

        assert.strictEqual(warnings.length, 0);
    });

    await runTest(
        '8. Salesforce error wording mapped from prior findings',
        () => {
            const message =
                'Cannot update a field from a Formula to something else';
            const mapped = mapExistingFindingWarnings([
                {
                    metadataName: 'Obj__c.Status__c',
                    metadataType: 'CustomField',
                    message
                }
            ]);

            assert.strictEqual(mapped.length, 1);
            assert.strictEqual(
                mapped[0].category,
                CATEGORIES.FORMULA_TYPE_CHANGE
            );
            assert.strictEqual(mapped[0].message, message);
            assert.strictEqual(mapped[0].autoExclude, false);
        }
    );

    await runTest(
        '9. Unrelated validation errors retain existing classifications',
        () => {
            const failureClassification = classifyDeploymentFailures({
                dependencyValidation: {
                    overallStatus: 'BLOCKED',
                    results: [
                        {
                            name: 'Weather',
                            type: 'ExternalCredential',
                            status: 'BLOCKED',
                            message:
                                'External Credential not found in destination org.'
                        }
                    ]
                }
            });

            assert.strictEqual(failureClassification.failures.length, 1);
            assert.strictEqual(
                failureClassification.failures[0].category,
                FAILURE_CATEGORIES.MANUAL_ACTION
            );
            assert.ok(
                failureClassification.failures[0].reason.includes(
                    'External Credential'
                )
            );
        }
    );

    await runTest(
        '10. Shape-based FORMULA_TYPE_CHANGE warnings do not auto-exclude',
        async () => {
            const metadataName = 'Obj__c.End_Time__c';
            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: buildPackage([metadataName]),
                sourceShapeIndex: sourceShape(metadataName, {
                    type: 'time',
                    mdapiType: 'Time',
                    calculated: false,
                    label: 'End Time'
                }),
                destinationShapeIndex: destinationShapeIndex({
                    [metadataName]: {
                        type: 'time',
                        calculated: true,
                        label: 'End Time'
                    }
                })
            });

            assert.ok(
                plan.compatibilityWarnings.some(
                    (w) =>
                        w.metadataName === metadataName &&
                        w.autoExclude === false
                )
            );

            const filterResult = filter({
                generatedDeploymentPackage: buildPackage([metadataName]),
                deploymentCompatibilityPlan: plan
            });

            assert.strictEqual(filterResult.excludedComponents.length, 0);
            assert.strictEqual(
                filterResult.deploymentPackage.metadata.length,
                1
            );
        }
    );

    await runTest(
        'CLI formula-to-non-formula error uses dedicated classification',
        () => {
            const failureClassification = classifyDeploymentFailures({
                deployOutcome: {
                    success: false,
                    failureDetails: [
                        {
                            metadataType: 'CustomField',
                            componentName: 'Obj__c.End_Time__c',
                            problem: SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR
                        }
                    ]
                }
            });

            assert.strictEqual(failureClassification.failures.length, 1);
            assert.ok(
                failureClassification.failures[0].reason.includes('formula')
            );
            assert.strictEqual(
                failureClassification.failures[0].evidence.problem,
                SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR
            );
        }
    );
}

main();
