'use strict';

const assert = require('assert');

const {
    classifyDeploymentFailures,
    CATEGORIES
} = require('./deploymentFailureClassification.service');

const SALESFORCE_FORMULA_ERROR =
    'Cannot update a field from a Formula to something else';

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

function shapeWarning(metadataName, message) {
    return {
        metadataType: 'CustomField',
        metadataName,
        category: 'FORMULA_TYPE_CHANGE',
        detectionSource: 'SHAPE_INDEX',
        autoExclude: false,
        message,
        expectedSalesforceError: SALESFORCE_FORMULA_ERROR,
        conflictFacts: {
            source: { calculated: false, type: 'Time' },
            destination: { calculated: true, type: 'time' }
        }
    };
}

async function main() {
    await runTest(
        'CLI formula error + matching SHAPE_INDEX warning → one failure',
        () => {
            const result = classifyDeploymentFailures({
                deployOutcome: {
                    success: false,
                    deploymentDiagnostics: {
                        componentFailures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.End_Time__c',
                                problem: SALESFORCE_FORMULA_ERROR
                            }
                        ]
                    }
                },
                compatibilityWarnings: [
                    shapeWarning(
                        'Session__c.End_Time__c',
                        'CustomField Session__c.End_Time__c: source Time vs destination formula.'
                    )
                ],
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.End_Time__c'
                    }
                ]
            });

            assert.strictEqual(result.failures.length, 1);
            assert.strictEqual(
                result.failures[0].key,
                'CustomField:Session__c.End_Time__c'
            );
        }
    );

    await runTest(
        'Consolidated failure preserves CLI error and compatibility evidence',
        () => {
            const compatMessage =
                'CustomField Session__c.Status__c: source Picklist vs destination formula.';
            const result = classifyDeploymentFailures({
                deploymentDiagnostics: {
                    componentFailures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Status__c',
                            problem: SALESFORCE_FORMULA_ERROR
                        }
                    ]
                },
                compatibilityWarnings: [
                    shapeWarning('Session__c.Status__c', compatMessage)
                ],
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Status__c'
                    }
                ]
            });

            const failure = result.failures[0];
            assert.strictEqual(failure.evidence.problem, SALESFORCE_FORMULA_ERROR);
            assert.strictEqual(
                failure.evidence.compatibilityExplanation,
                compatMessage
            );
            assert.strictEqual(failure.evidence.detectionSource, 'SHAPE_INDEX');
            assert.ok(failure.evidence.conflictFacts);
            assert.deepStrictEqual(failure.evidence.sources, [
                'CLI',
                'COMPATIBILITY'
            ]);
            assert.strictEqual(failure.reason, compatMessage);
            assert.strictEqual(failure.category, CATEGORIES.MANUAL_ACTION);
        }
    );

    await runTest('Different field warnings remain separate failures', () => {
        const result = classifyDeploymentFailures({
            deploymentDiagnostics: {
                componentFailures: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.End_Time__c',
                        problem: SALESFORCE_FORMULA_ERROR
                    }
                ]
            },
            compatibilityWarnings: [
                shapeWarning(
                    'Session__c.Status__c',
                    'Status shape conflict only.'
                )
            ]
        });

        assert.strictEqual(result.failures.length, 2);
    });

    await runTest(
        'Unrelated CLI error on same field stays separate from shape warning',
        () => {
            const result = classifyDeploymentFailures({
                deploymentDiagnostics: {
                    componentFailures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.End_Time__c',
                            problem: 'Unable to find related field Foo__c'
                        }
                    ]
                },
                compatibilityWarnings: [
                    shapeWarning(
                        'Session__c.End_Time__c',
                        'Formula shape mismatch.'
                    )
                ]
            });

            assert.strictEqual(result.failures.length, 2);
        }
    );

    await runTest('Duplicate identical compatibility warnings dedupe once', () => {
        const warning = shapeWarning(
            'Obj__c.Only__c',
            'Only compatibility, no CLI.'
        );
        const result = classifyDeploymentFailures({
            compatibilityWarnings: [warning, warning],
            deploymentCompatibilityPlan: {
                compatibilityWarnings: [warning]
            }
        });

        assert.strictEqual(result.failures.length, 1);
    });

    await runTest('Sales Manager Profile permission error remains visible', () => {
        const result = classifyDeploymentFailures({
            deployOutcome: {
                success: false,
                failureDetails: [
                    {
                        metadataType: 'Profile',
                        componentName: 'Sales Manager',
                        problem: 'Unknown user permission: CreateWorkBadgeDefinition'
                    }
                ]
            }
        });

        assert.strictEqual(result.failures.length, 1);
        assert.strictEqual(result.failures[0].metadataType, 'Profile');
        assert.strictEqual(result.failures[0].metadataName, 'Sales Manager');
        assert.ok(
            String(result.failures[0].evidence.problem).includes(
                'CreateWorkBadgeDefinition'
            )
        );
    });
}

main();
