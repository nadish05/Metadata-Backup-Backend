'use strict';

const assert = require('assert');

const {
    LOG_PREFIX,
    resolveBackendBuildId,
    buildDeploymentValidationDiagnostic,
    logDeploymentValidationDiagnostic
} = require('./deploymentValidationDiagnostic.service');

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

const SALESFORCE_FORMULA_ERROR =
    'Cannot update a field from a Formula to something else';

function shapeWarning(metadataName) {
    return {
        metadataType: 'CustomField',
        metadataName,
        category: 'FORMULA_TYPE_CHANGE',
        detectionSource: 'SHAPE_INDEX',
        autoExclude: false,
        message: `Shape conflict for ${metadataName}`,
        conflictFacts: {
            source: { calculated: false, type: 'Time' },
            destination: { calculated: true, type: 'time' }
        },
        expectedSalesforceError: SALESFORCE_FORMULA_ERROR
    };
}

function mergedFailure(metadataName) {
    return {
        key: `CustomField:${metadataName}`,
        metadataType: 'CustomField',
        metadataName,
        category: 'MANUAL_ACTION',
        reason: `Shape conflict for ${metadataName}`,
        evidence: {
            problem: SALESFORCE_FORMULA_ERROR,
            source: 'CLI',
            sources: ['CLI', 'COMPATIBILITY']
        }
    };
}

function cliOnlyFailure(metadataName) {
    return {
        key: `CustomField:${metadataName}`,
        metadataType: 'CustomField',
        metadataName,
        category: 'MANUAL_ACTION',
        reason:
            'Salesforce cannot replace an existing formula field with a non-formula field definition via Metadata API deploy.',
        evidence: {
            problem: SALESFORCE_FORMULA_ERROR,
            source: 'CLI'
        }
    };
}

function compatOnlyFailure(metadataName) {
    return {
        key: `CustomField:${metadataName}`,
        metadataType: 'CustomField',
        metadataName,
        category: 'MANUAL_ACTION',
        reason: `Shape conflict for ${metadataName}`,
        evidence: {
            problem: `Shape conflict for ${metadataName}`,
            source: 'COMPATIBILITY'
        }
    };
}

async function main() {
    await runTest('resolveBackendBuildId uses GIT_COMMIT or unknown', () => {
        const original = process.env.GIT_COMMIT;
        process.env.GIT_COMMIT = 'abc123def';
        assert.strictEqual(resolveBackendBuildId(), 'abc123def');
        delete process.env.GIT_COMMIT;
        assert.strictEqual(resolveBackendBuildId(), 'unknown');
        if (original !== undefined) {
            process.env.GIT_COMMIT = original;
        }
    });

    await runTest('policy enabled and exclusions applied', () => {
        const record = buildDeploymentValidationDiagnostic({
            validationId: 'validation_test-1',
            finalResponse: {
                deploymentValidationScope: {
                    autoExcludeShapeFormulaConflicts: true,
                    packageComponentCountBeforeFilter: 10,
                    packageComponentCountAfterFilter: 8
                },
                shapeFormulaExclusionPolicy: {
                    enabled: true,
                    applied: true,
                    revertedDueToBlockingDependencies: false,
                    suppressedExclusions: [],
                    blockedDependents: []
                },
                compatibilityWarnings: [shapeWarning('Session__c.End_Time__c')],
                excludedComponents: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.End_Time__c',
                        exclusionPolicy: 'SHAPE_DESTINATION_FORMULA',
                        exclusionSource: 'SHAPE_FORMULA_POLICY'
                    }
                ],
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Status__c'
                        }
                    ],
                    dependencies: []
                },
                generatedManifest: {
                    packageXml:
                        '<types><members>Session__c.Status__c</members><name>CustomField</name></types>'
                },
                failureClassification: { failures: [] },
                checkOnlyDeployment: {
                    executed: true,
                    success: false,
                    deploymentDiagnostics: { componentFailures: [] }
                }
            },
            compatibilityFilterError: false
        });

        assert.strictEqual(record.autoExcludeShapeFormulaConflicts, true);
        assert.strictEqual(record.shapePolicy.applied, true);
        const endTime = record.targetFields.find(
            (field) => field.metadataName === 'Session__c.End_Time__c'
        );
        assert.strictEqual(endTime.exclusionEligible, true);
        assert.strictEqual(endTime.excluded, true);
        assert.strictEqual(endTime.inFinalPackage, false);
        assert.strictEqual(endTime.inManifest, false);
    });

    await runTest('policy disabled leaves eligibility null without warning facts path', () => {
        const record = buildDeploymentValidationDiagnostic({
            finalResponse: {
                deploymentValidationScope: {
                    autoExcludeShapeFormulaConflicts: false
                },
                shapeFormulaExclusionPolicy: {
                    enabled: false,
                    applied: false
                },
                compatibilityWarnings: [],
                generatedDeploymentPackage: { metadata: [], dependencies: [] }
            }
        });

        assert.strictEqual(record.autoExcludeShapeFormulaConflicts, false);
        assert.strictEqual(record.shapePolicy.enabled, false);
        const endTime = record.targetFields.find(
            (field) => field.metadataName === 'Session__c.End_Time__c'
        );
        assert.strictEqual(endTime.exclusionEligible, null);
        assert.strictEqual(endTime.warningDetectionSource, null);
    });

    await runTest('exclusions reverted surfaces suppressed and blocked dependents', () => {
        const record = buildDeploymentValidationDiagnostic({
            finalResponse: {
                shapeFormulaExclusionPolicy: {
                    enabled: true,
                    applied: false,
                    revertedDueToBlockingDependencies: true,
                    suppressedExclusions: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Status__c',
                            reason: 'shape policy'
                        }
                    ],
                    blockedDependents: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Uses_Status',
                            message: 'depends on field'
                        }
                    ]
                },
                compatibilityWarnings: [shapeWarning('Session__c.Status__c')],
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Status__c'
                        }
                    ],
                    dependencies: []
                },
                generatedManifest: {
                    packageXml:
                        '<members>Session__c.Status__c</members>'
                }
            }
        });

        assert.strictEqual(
            record.shapePolicy.revertedDueToBlockingDependencies,
            true
        );
        assert.strictEqual(record.shapePolicy.suppressedExclusions.length, 1);
        assert.strictEqual(record.shapePolicy.blockedDependents.length, 1);
        const status = record.targetFields.find(
            (field) => field.metadataName === 'Session__c.Status__c'
        );
        assert.strictEqual(status.inFinalPackage, true);
        assert.strictEqual(status.inManifest, true);
    });

    await runTest('merged CLI + compatibility failure flagged per field', () => {
        const record = buildDeploymentValidationDiagnostic({
            finalResponse: {
                compatibilityWarnings: [shapeWarning('Session__c.End_Time__c')],
                failureClassification: {
                    failures: [mergedFailure('Session__c.End_Time__c')]
                }
            }
        });

        const endTime = record.targetFields.find(
            (field) => field.metadataName === 'Session__c.End_Time__c'
        );
        assert.strictEqual(endTime.failureEntryCount, 1);
        assert.strictEqual(
            endTime.failureClassification[0].cliCompatibilityMerged,
            true
        );
    });

    await runTest('two unmerged failures for same field', () => {
        const record = buildDeploymentValidationDiagnostic({
            finalResponse: {
                compatibilityWarnings: [shapeWarning('Session__c.Status__c')],
                failureClassification: {
                    failures: [
                        cliOnlyFailure('Session__c.Status__c'),
                        compatOnlyFailure('Session__c.Status__c')
                    ]
                }
            }
        });

        const status = record.targetFields.find(
            (field) => field.metadataName === 'Session__c.Status__c'
        );
        assert.strictEqual(status.failureEntryCount, 2);
        assert.strictEqual(
            status.failureClassification[0].cliCompatibilityMerged,
            false
        );
        assert.strictEqual(
            status.failureClassification[1].cliCompatibilityMerged,
            false
        );
    });

    await runTest('check-only skipped', () => {
        const record = buildDeploymentValidationDiagnostic({
            finalResponse: {
                checkOnlyDeployment: {
                    executed: false,
                    status: 'NOT_EXECUTED',
                    skipReason: 'Compatibility readiness reported blocking dependencies.'
                }
            }
        });

        assert.strictEqual(record.checkOnlySkipped, true);
        assert.ok(record.checkOnlySkippedReason);
        assert.strictEqual(record.checkOnly.executed, false);
    });

    await runTest('compatibility filter error represented explicitly', () => {
        const record = buildDeploymentValidationDiagnostic({
            compatibilityFilterError: true,
            finalResponse: {}
        });
        assert.strictEqual(record.compatibilityFilterError, true);
    });

    await runTest('log output excludes tokens and uses prefix', () => {
        const lines = [];
        const original = console.log;
        console.log = (...args) => {
            lines.push(args.join(' '));
        };

        try {
            logDeploymentValidationDiagnostic({
                event: 'deployment.validation.completed',
                validationId: 'validation_x',
                secretProbe: 'refresh_token=abc access_token=def'
            });
        } finally {
            console.log = original;
        }

        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].startsWith(LOG_PREFIX));
        assert.ok(!lines[0].includes('Bearer '));
    });
}

main();
