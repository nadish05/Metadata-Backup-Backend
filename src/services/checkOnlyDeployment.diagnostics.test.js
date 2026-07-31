const assert = require('assert');

const {
    mapDeployOutcome,
    mapComponentFailureDiagnostic,
    mapComponentSuccessDiagnostic,
    buildDeploymentDiagnostics,
    buildEmptyDeploymentDiagnostics,
    mapFailureDetails
} = require('./checkOnlyDeployment.service');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

runTest('Deployment with no failures → empty diagnostic failures', () => {
    const outcome = mapDeployOutcome({
        cliJson: {
            result: {
                id: '0AfSUCCESS',
                success: true,
                status: 'Succeeded',
                createdDate: '2026-07-31T06:00:00.000Z',
                completedDate: '2026-07-31T06:00:05.000Z',
                numberComponentsDeployed: 2,
                details: {
                    componentSuccesses: [
                        {
                            fullName: 'HelperService',
                            componentType: 'ApexClass',
                            success: true,
                            changed: true,
                            created: false,
                            deleted: false
                        },
                        {
                            fullName: 'Experience__c.Status__c',
                            componentType: 'CustomField',
                            success: true,
                            changed: false,
                            created: true,
                            deleted: false
                        }
                    ],
                    componentFailures: []
                }
            }
        },
        elapsedMs: 5000,
        executionMode: 'dry-run'
    });

    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.status, 'SUCCESS');
    assert.strictEqual(outcome.componentFailures, 0);
    assert.deepStrictEqual(outcome.failureDetails, []);
    assert.ok(outcome.deploymentDiagnostics);
    assert.strictEqual(outcome.deploymentDiagnostics.deploymentId, '0AfSUCCESS');
    assert.strictEqual(outcome.deploymentDiagnostics.overallStatus, 'SUCCESS');
    assert.strictEqual(
        outcome.deploymentDiagnostics.componentFailures.length,
        0
    );
    assert.strictEqual(
        outcome.deploymentDiagnostics.componentSuccesses.length,
        2
    );
    assert.strictEqual(
        outcome.deploymentDiagnostics.summary.totalFailures,
        0
    );
});

runTest('Deployment with multiple failures captures every component', () => {
    const outcome = mapDeployOutcome({
        cliJson: {
            result: {
                id: '0Afd200000SUKE5CAP',
                success: false,
                status: 'Failed',
                details: {
                    componentSuccesses: [],
                    componentFailures: [
                        {
                            fullName: 'Experience__c.Price__c',
                            componentType: 'CustomField',
                            fileName:
                                'objects/Experience__c/fields/Price__c.field-meta.xml',
                            problem:
                                'Cannot update a field to a Formula from something else',
                            problemType: 'Error',
                            lineNumber: 12,
                            columnNumber: 4,
                            success: false,
                            changed: true,
                            created: false,
                            deleted: false
                        },
                        {
                            fullName: 'Session__c.Capacity__c',
                            componentType: 'CustomField',
                            problem: 'duplicate value found',
                            problemType: 'Error',
                            success: false
                        }
                    ]
                }
            }
        },
        elapsedMs: 1200,
        executionMode: 'dry-run'
    });

    assert.strictEqual(outcome.success, false);
    assert.strictEqual(outcome.status, 'FAILED');
    assert.strictEqual(outcome.componentFailures, 2);
    assert.strictEqual(outcome.failureDetails.length, 2);
    // Backward-compatible failureDetails shape preserved.
    assert.strictEqual(
        outcome.failureDetails[0].componentName,
        'Experience__c.Price__c'
    );
    assert.strictEqual(
        outcome.failureDetails[0].problem,
        'Cannot update a field to a Formula from something else'
    );

    const diagnostics = outcome.deploymentDiagnostics;
    assert.strictEqual(diagnostics.deploymentId, '0Afd200000SUKE5CAP');
    assert.strictEqual(diagnostics.overallStatus, 'FAILED');
    assert.strictEqual(diagnostics.componentFailures.length, 2);
    assert.strictEqual(
        diagnostics.componentFailures[0].metadataType,
        'CustomField'
    );
    assert.strictEqual(
        diagnostics.componentFailures[0].metadataName,
        'Experience__c.Price__c'
    );
    assert.strictEqual(
        diagnostics.componentFailures[0].fullName,
        'Experience__c.Price__c'
    );
    assert.strictEqual(
        diagnostics.componentFailures[0].problem,
        'Cannot update a field to a Formula from something else'
    );
    assert.strictEqual(diagnostics.componentFailures[1].fullName, 'Session__c.Capacity__c');
    assert.ok(diagnostics.componentFailures[0].rawFailure);
    assert.strictEqual(diagnostics.summary.totalFailures, 2);
});

runTest('Missing optional fields map to null without throwing', () => {
    const diagnostic = mapComponentFailureDiagnostic({
        componentType: 'ApexClass'
    });

    assert.strictEqual(diagnostic.metadataType, 'ApexClass');
    assert.strictEqual(diagnostic.metadataName, null);
    assert.strictEqual(diagnostic.fullName, null);
    assert.strictEqual(diagnostic.fileName, null);
    assert.strictEqual(diagnostic.problem, null);
    assert.strictEqual(diagnostic.problemType, null);
    assert.strictEqual(diagnostic.lineNumber, null);
    assert.strictEqual(diagnostic.columnNumber, null);
    assert.strictEqual(diagnostic.success, false);
    assert.strictEqual(diagnostic.changed, null);
    assert.strictEqual(diagnostic.created, null);
    assert.strictEqual(diagnostic.deleted, null);
    assert.strictEqual(diagnostic.warning, null);
    assert.strictEqual(diagnostic.errorStatus, null);
    assert.ok(diagnostic.rawFailure);
});

runTest('Null / undefined failure payloads are safe', () => {
    assert.strictEqual(mapFailureDetails(null).length, 0);
    assert.strictEqual(mapFailureDetails(undefined).length, 0);

    const empty = mapComponentFailureDiagnostic(null);
    assert.strictEqual(empty.success, false);
    assert.strictEqual(empty.rawFailure, null);
});

runTest('Deployment with warnings only (no component failures)', () => {
    const outcome = mapDeployOutcome({
        cliJson: {
            result: {
                id: '0AfWARN',
                success: true,
                status: 'Succeeded',
                details: {
                    componentSuccesses: [
                        {
                            fullName: 'HelperService',
                            componentType: 'ApexClass',
                            success: true,
                            warning: 'Deprecated API usage'
                        }
                    ],
                    componentFailures: []
                }
            },
            warnings: ['CLI advisory warning']
        },
        elapsedMs: 800,
        executionMode: 'dry-run'
    });

    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.componentFailures, 0);
    assert.ok(outcome.warnings.includes('Deprecated API usage'));
    assert.ok(outcome.warnings.includes('CLI advisory warning'));
    assert.strictEqual(
        outcome.deploymentDiagnostics.componentFailures.length,
        0
    );
    assert.strictEqual(
        outcome.deploymentDiagnostics.componentSuccesses[0].warning,
        'Deprecated API usage'
    );
    assert.strictEqual(
        outcome.deploymentDiagnostics.summary.warningCount,
        outcome.warnings.length
    );
});

runTest('Line and column information are preserved', () => {
    const diagnostic = mapComponentFailureDiagnostic({
        fullName: 'Experience__c.Price__c',
        componentType: 'CustomField',
        fileName: 'objects/Experience__c/fields/Price__c.field-meta.xml',
        problem: 'Cannot update a field to a Formula from something else',
        problemType: 'Error',
        lineNumber: 18,
        columnNumber: 7,
        success: false,
        changed: true,
        created: false,
        deleted: false,
        errorStatusCode: 'FIELD_INTEGRITY_EXCEPTION'
    });

    assert.strictEqual(diagnostic.lineNumber, 18);
    assert.strictEqual(diagnostic.columnNumber, 7);
    assert.strictEqual(diagnostic.errorStatus, 'FIELD_INTEGRITY_EXCEPTION');
    assert.strictEqual(diagnostic.changed, true);
    assert.strictEqual(diagnostic.created, false);
    assert.strictEqual(diagnostic.deleted, false);
});

runTest('buildDeploymentDiagnostics aggregates successes and failures', () => {
    const diagnostics = buildDeploymentDiagnostics({
        deployResult: { id: '0AfX', status: 'Failed', success: false },
        details: {
            componentFailures: [
                {
                    fullName: 'A__c.B__c',
                    componentType: 'CustomField',
                    problem: 'bad'
                }
            ],
            componentSuccesses: [
                {
                    fullName: 'HelperService',
                    componentType: 'ApexClass',
                    success: true
                }
            ]
        },
        status: 'FAILED',
        warnings: ['one']
    });

    assert.strictEqual(diagnostics.deploymentId, '0AfX');
    assert.strictEqual(diagnostics.overallStatus, 'FAILED');
    assert.strictEqual(diagnostics.componentFailures.length, 1);
    assert.strictEqual(diagnostics.componentSuccesses.length, 1);
    assert.strictEqual(diagnostics.summary.totalFailures, 1);
    assert.strictEqual(diagnostics.summary.totalSuccesses, 1);
    assert.strictEqual(diagnostics.summary.warningCount, 1);
});

runTest('Empty diagnostics builder for blocked/failed paths', () => {
    const empty = buildEmptyDeploymentDiagnostics({ status: 'BLOCKED' });

    assert.strictEqual(empty.deploymentId, null);
    assert.strictEqual(empty.overallStatus, 'BLOCKED');
    assert.deepStrictEqual(empty.componentFailures, []);
    assert.deepStrictEqual(empty.componentSuccesses, []);
    assert.strictEqual(empty.summary.totalFailures, 0);
});

runTest('Success diagnostic mapping preserves identity fields', () => {
    const success = mapComponentSuccessDiagnostic({
        fullName: 'c:myComponent',
        componentType: 'LightningComponentBundle',
        fileName: 'lwc/myComponent/myComponent.js-meta.xml',
        success: true,
        created: true,
        changed: false,
        deleted: false
    });

    assert.strictEqual(success.metadataType, 'LightningComponentBundle');
    assert.strictEqual(success.metadataName, 'c:myComponent');
    assert.strictEqual(success.success, true);
    assert.strictEqual(success.created, true);
    assert.ok(success.rawSuccess);
});

runTest('Backward-compatible fields remain on mapDeployOutcome', () => {
    const outcome = mapDeployOutcome({
        cliJson: {
            result: {
                id: '0AfCompat',
                success: false,
                status: 'Failed',
                details: {
                    componentFailures: [
                        {
                            fullName: 'X__c.Y__c',
                            componentType: 'CustomField',
                            problem: 'oops',
                            fileName: 'x.xml',
                            lineNumber: 3,
                            columnNumber: 1
                        }
                    ],
                    componentSuccesses: []
                }
            }
        },
        elapsedMs: 10,
        executionMode: 'deploy',
        mode: 'execution'
    });

    // Existing properties must still exist with prior shapes.
    assert.ok('deploymentId' in outcome);
    assert.ok('status' in outcome);
    assert.ok('success' in outcome);
    assert.ok('failureDetails' in outcome);
    assert.ok('componentSuccesses' in outcome);
    assert.ok('componentFailures' in outcome);
    assert.ok('deploymentSummary' in outcome);
    assert.ok('message' in outcome);
    assert.ok('deploymentDiagnostics' in outcome);

    assert.strictEqual(outcome.failureDetails[0].componentName, 'X__c.Y__c');
    assert.strictEqual(outcome.failureDetails[0].file, 'x.xml');
    assert.strictEqual(outcome.failureDetails[0].line, 3);
    assert.strictEqual(outcome.failureDetails[0].column, 1);
    assert.strictEqual(
        outcome.deploymentSummary.componentsFailed,
        1
    );
});

if (process.exitCode) {
    process.exit(process.exitCode);
}
