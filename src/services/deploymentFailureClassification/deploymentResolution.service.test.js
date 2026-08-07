const assert = require('assert');

const {
    classifyDeploymentFailures,
    CATEGORIES
} = require('./deploymentFailureClassification.service');
const {
    buildResolutionReport,
    RESOLUTION_TYPES
} = require('./deploymentResolution.service');

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

async function main() {
    await runTest('PersonAccount failure maps to ENABLE_FEATURE', () => {
        const failureClassification = classifyDeploymentFailures({
            deployOutcome: {
                success: false,
                failureDetails: [
                    {
                        componentName: 'PersonAccount.PersonAccount',
                        metadataType: 'RecordType',
                        problem:
                            'no RecordType named PersonAccount.PersonAccount found'
                    }
                ]
            }
        });
        const report = buildResolutionReport({ failureClassification });

        assert.strictEqual(failureClassification.failures.length, 1);
        assert.strictEqual(
            failureClassification.failures[0].category,
            CATEGORIES.MANUAL_ACTION
        );
        assert.strictEqual(report.resolutions.length, 1);
        assert.strictEqual(
            report.resolutions[0].resolutionType,
            RESOLUTION_TYPES.ENABLE_FEATURE
        );
        assert.strictEqual(report.resolutions[0].userActionRequired, true);
        assert.strictEqual(report.resolutions[0].autoFixAvailable, false);
        assert.strictEqual(report.resolutions[0].safeSkipAvailable, false);
    });

    await runTest(
        'Formula incompatibility maps to MANUAL_METADATA_CHANGE',
        () => {
            const failureClassification = classifyDeploymentFailures({
                compatibilityWarnings: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        category: 'FORMULA_TYPE_CHANGE',
                        message: 'Formula type conversion is incompatible.'
                    }
                ],
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c'
                    }
                ]
            });
            const report = buildResolutionReport({ failureClassification });

            assert.strictEqual(
                failureClassification.failures[0].category,
                CATEGORIES.MANUAL_ACTION
            );
            assert.strictEqual(
                report.resolutions[0].resolutionType,
                RESOLUTION_TYPES.MANUAL_METADATA_CHANGE
            );
            assert.strictEqual(report.summary.manualActions, 1);
        }
    );

    await runTest('Missing dependency maps to DEPENDENCY', () => {
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
        const report = buildResolutionReport({ failureClassification });

        assert.strictEqual(
            report.resolutions[0].resolutionType,
            RESOLUTION_TYPES.DEPENDENCY
        );
        assert.strictEqual(report.resolutions[0].metadataName, 'Weather');
    });

    await runTest('Missing package member maps to PACKAGE', () => {
        const failureClassification = {
            overallStatus: 'CLASSIFIED',
            failures: [
                {
                    key: 'CustomObject:Gym_Trainer__c',
                    metadataType: 'CustomObject',
                    metadataName: 'Gym_Trainer__c',
                    category: CATEGORIES.MANUAL_ACTION,
                    confidence: 'HIGH',
                    deterministic: true,
                    canAutoFix: false,
                    canSafeSkip: false,
                    requiresUserAction: true,
                    aiExplanationUseful: true,
                    reason:
                        'Add this dependency to the deployment package.',
                    evidence: {
                        problem:
                            'Dependency is missing and not included in the package.',
                        source: 'DEPENDENCY_VALIDATION'
                    },
                    recommendedNextStep:
                        'Add this dependency to the deployment package.'
                }
            ],
            summary: {
                autoFix: 0,
                safeSkip: 0,
                manualAction: 1,
                information: 0,
                unclassified: 0
            }
        };

        const report = buildResolutionReport({
            failureClassification,
            deploymentPackage: {
                metadata: [],
                dependencies: []
            }
        });

        assert.strictEqual(
            report.resolutions[0].resolutionType,
            RESOLUTION_TYPES.PACKAGE
        );
        assert.strictEqual(report.resolutions[0].userActionRequired, true);
    });

    await runTest('CLI retry candidate maps to RETRY', () => {
        const failureClassification = classifyDeploymentFailures({
            deployOutcome: {
                success: false,
                message: 'socket hang up — temporarily unavailable, try again',
                failureDetails: []
            }
        });
        const report = buildResolutionReport({ failureClassification });

        assert.ok(report.resolutions.length >= 1);
        assert.strictEqual(
            report.resolutions[0].resolutionType,
            RESOLUTION_TYPES.RETRY
        );
        assert.strictEqual(report.resolutions[0].retryRecommended, true);
        assert.strictEqual(report.summary.retryCandidates, 1);
    });

    await runTest('Informational warning maps to INFORMATION', () => {
        const failureClassification = classifyDeploymentFailures({
            deployOutcome: {
                success: true,
                warnings: ['Deploy completed with a non-blocking warning.']
            }
        });
        const report = buildResolutionReport({ failureClassification });

        assert.strictEqual(
            failureClassification.failures[0].category,
            CATEGORIES.INFORMATION
        );
        assert.strictEqual(
            report.resolutions[0].resolutionType,
            RESOLUTION_TYPES.INFORMATION
        );
        assert.strictEqual(report.summary.informational, 1);
        assert.strictEqual(report.resolutions[0].userActionRequired, false);
    });

    await runTest(
        'Resolution engine is side-effect free for empty classification',
        () => {
            const report = buildResolutionReport({
                failureClassification: {
                    overallStatus: 'NONE',
                    failures: [],
                    summary: {
                        autoFix: 0,
                        safeSkip: 0,
                        manualAction: 0,
                        information: 0,
                        unclassified: 0
                    }
                }
            });

            assert.strictEqual(report.overallStatus, 'NONE');
            assert.deepStrictEqual(report.resolutions, []);
        }
    );

    if (!process.exitCode) {
        console.log('deploymentResolution.service tests passed');
    }
}

main();
