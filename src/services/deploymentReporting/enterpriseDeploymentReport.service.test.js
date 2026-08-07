const assert = require('assert');

const {
    buildEnterpriseDeploymentReport,
    NEXT_ACTION_PRIORITY,
    REPORT_VERSION
} = require('./enterpriseDeploymentReport.service');

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
    await runTest('Successful deployment', () => {
        const report = buildEnterpriseDeploymentReport({
            generatedAt: '2026-08-07T12:00:00.000Z',
            deploymentSummary: {
                deploymentStatus: 'Succeeded',
                success: true,
                componentsValidated: 4,
                successfulComponents: 4,
                failedComponents: 0,
                durationMs: 1200,
                deploymentMode: 'VALIDATE'
            },
            deploymentDiagnostics: {
                componentFailures: [],
                componentSuccesses: [{}, {}, {}, {}]
            },
            failureClassification: { failures: [], summary: {} },
            resolutionReport: { resolutions: [], summary: {} },
            autoFixReport: {
                autoFixAvailable: false,
                autoFixApplied: false,
                fixes: []
            },
            autoValidationReport: {
                attempts: 1,
                autoValidationExecuted: false,
                initialStatus: 'SUCCESS',
                finalStatus: 'SUCCESS',
                revalidated: false
            },
            aiResolutionReport: {
                available: true,
                generated: true,
                explanations: []
            }
        });

        assert.strictEqual(report.version, REPORT_VERSION);
        assert.strictEqual(report.generatedAt, '2026-08-07T12:00:00.000Z');
        assert.strictEqual(report.overallStatus, 'SUCCESS');
        assert.strictEqual(report.summary.deploymentStatus, 'SUCCESS');
        assert.strictEqual(report.summary.executionMode, 'VALIDATE');
        assert.strictEqual(report.summary.duration, 1200);
        assert.strictEqual(report.summary.totalMetadata, 4);
        assert.strictEqual(report.summary.successfulMetadata, 4);
        assert.strictEqual(report.summary.failedMetadata, 0);
        assert.strictEqual(report.summary.autoFixesApplied, 0);
        assert.strictEqual(report.summary.validationAttempts, 1);
        assert.deepStrictEqual(report.failures, []);
        assert.deepStrictEqual(report.nextActions, []);
        assert.strictEqual(report.statistics.autoResolved, 0);
    });

    await runTest('Failed deployment', () => {
        const report = buildEnterpriseDeploymentReport({
            deploymentSummary: {
                success: false,
                deploymentStatus: 'Failed',
                componentsValidated: 2,
                failedComponents: 1,
                successfulComponents: 1
            },
            deploymentDiagnostics: {
                componentFailures: [{ metadataName: 'Account.Score__c' }]
            },
            failureClassification: {
                failures: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        category: 'MANUAL_ACTION',
                        reason: 'Formula type conversion is incompatible.',
                        evidence: { source: 'COMPATIBILITY' }
                    }
                ],
                summary: { manualAction: 1, information: 0 }
            },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE',
                        recommendation: 'Create a new field.'
                    }
                ],
                summary: { manualActions: 1 }
            },
            autoFixReport: { fixes: [] },
            autoValidationReport: {
                attempts: 1,
                finalStatus: 'FAILED',
                revalidated: false
            },
            aiResolutionReport: { available: false, explanations: [] }
        });

        assert.strictEqual(report.overallStatus, 'FAILED');
        assert.strictEqual(report.failures.length, 1);
        assert.strictEqual(report.resolutions.length, 1);
        assert.strictEqual(report.nextActions[0].type, 'MANUAL_METADATA_CHANGE');
        assert.strictEqual(
            report.nextActions[0].priority,
            NEXT_ACTION_PRIORITY.MANUAL_METADATA_CHANGE
        );
        assert.strictEqual(report.nextActions[0].completed, false);
        assert.strictEqual(report.statistics.compatibilityFailures, 1);
        assert.strictEqual(report.statistics.manualActions, 1);
    });

    await runTest('Auto-fixed deployment', () => {
        const report = buildEnterpriseDeploymentReport({
            deploymentSummary: { success: true, deploymentStatus: 'Succeeded' },
            failureClassification: { failures: [], summary: {} },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        resolutionType: 'DEPENDENCY',
                        recommendation: 'Include Weather credential.'
                    }
                ],
                summary: {}
            },
            autoFixReport: {
                autoFixAvailable: true,
                autoFixApplied: true,
                fixes: [
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                        action: 'Included in deployment package',
                        executed: true,
                        successful: true
                    },
                    {
                        fixType: 'REGENERATE_PACKAGE',
                        executed: true,
                        successful: true
                    }
                ]
            },
            autoValidationReport: {
                attempts: 2,
                autoValidationExecuted: true,
                initialStatus: 'FAILED',
                finalStatus: 'SUCCESS',
                autoFixesApplied: 2,
                revalidated: true
            },
            aiResolutionReport: {
                available: true,
                explanations: [
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        title: 'Auto-fixed dependency',
                        recommendedAction:
                            'Dependency was automatically added during validation.'
                    }
                ]
            }
        });

        assert.strictEqual(report.overallStatus, 'SUCCESS');
        assert.strictEqual(report.summary.validationAttempts, 2);
        assert.strictEqual(report.summary.autoFixesApplied, 2);
        assert.strictEqual(report.autoFixes.length, 2);
        assert.strictEqual(report.aiRecommendations.length, 1);
        assert.strictEqual(report.nextActions[0].type, 'AUTO_FIX_APPLIED');
        assert.strictEqual(report.nextActions[0].completed, true);
        assert.strictEqual(report.nextActions[0].metadataName, 'Weather');
        // Dependency resolution suppressed because auto-fixed.
        assert.ok(
            !report.nextActions.some(
                (action) => action.type === 'MANUAL_CONFIGURATION'
            )
        );
        assert.strictEqual(report.statistics.autoResolved, 2);
        assert.strictEqual(report.statistics.dependencyFailures, 1);
    });

    await runTest('Manual-action deployment', () => {
        const report = buildEnterpriseDeploymentReport({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        category: 'MANUAL_ACTION',
                        reason: 'Person Accounts required.'
                    }
                ],
                summary: { manualAction: 1 }
            },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        resolutionType: 'ENABLE_FEATURE',
                        recommendation: 'Enable Person Accounts.'
                    }
                ],
                summary: { manualActions: 1 }
            },
            autoFixReport: { fixes: [] },
            autoValidationReport: { attempts: 1, finalStatus: 'FAILED' },
            aiResolutionReport: { available: true, explanations: [] }
        });

        assert.strictEqual(report.overallStatus, 'FAILED');
        assert.strictEqual(report.nextActions[0].type, 'ENABLE_PLATFORM_FEATURE');
        assert.strictEqual(
            report.nextActions[0].priority,
            NEXT_ACTION_PRIORITY.ENABLE_PLATFORM_FEATURE
        );
        assert.strictEqual(report.statistics.manualActions, 1);
    });

    await runTest('AI disabled', () => {
        const report = buildEnterpriseDeploymentReport({
            failureClassification: { failures: [] },
            resolutionReport: { resolutions: [] },
            autoFixReport: { fixes: [] },
            autoValidationReport: { attempts: 1, finalStatus: 'SUCCESS' },
            aiResolutionReport: {
                available: false,
                generated: false,
                explanations: [],
                summary: 'AI Resolution Layer is disabled.'
            }
        });

        assert.deepStrictEqual(report.aiRecommendations, []);
        assert.strictEqual(report.overallStatus, 'SUCCESS');
    });

    await runTest('Empty failures', () => {
        const report = buildEnterpriseDeploymentReport({
            failureClassification: { failures: [], summary: {} },
            resolutionReport: { resolutions: [], summary: {} },
            autoFixReport: { fixes: [] },
            autoValidationReport: { attempts: 1, finalStatus: 'SUCCESS' },
            aiResolutionReport: { available: true, explanations: [] }
        });

        assert.deepStrictEqual(report.failures, []);
        assert.deepStrictEqual(report.resolutions, []);
        assert.deepStrictEqual(report.nextActions, []);
        assert.strictEqual(report.statistics.dependencyFailures, 0);
        assert.strictEqual(report.statistics.compatibilityFailures, 0);
        assert.strictEqual(report.statistics.manualActions, 0);
        assert.strictEqual(report.statistics.autoResolved, 0);
        assert.strictEqual(report.statistics.warnings, 0);
    });

    await runTest('Multiple next actions', () => {
        const report = buildEnterpriseDeploymentReport({
            failureClassification: { failures: [] },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Transient',
                        resolutionType: 'RETRY',
                        recommendation: 'Retry validation.'
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE',
                        recommendation: 'Recreate field.'
                    },
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        resolutionType: 'ENABLE_FEATURE',
                        recommendation: 'Enable Person Accounts.'
                    },
                    {
                        metadataType: null,
                        metadataName: null,
                        resolutionType: 'INFORMATION',
                        recommendation: 'Transient warning only.'
                    }
                ]
            },
            autoFixReport: {
                fixes: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Onboard',
                        fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                        successful: true,
                        action: 'Included in deployment package'
                    }
                ]
            },
            autoValidationReport: { attempts: 2, finalStatus: 'FAILED' },
            aiResolutionReport: { available: false, explanations: [] }
        });

        assert.strictEqual(report.nextActions.length, 5);
        assert.deepStrictEqual(
            report.nextActions.map((action) => action.type),
            [
                'AUTO_FIX_APPLIED',
                'RETRY_VALIDATION',
                'MANUAL_METADATA_CHANGE',
                'ENABLE_PLATFORM_FEATURE',
                'INFORMATIONAL'
            ]
        );
        assert.strictEqual(report.nextActions[0].completed, true);
        assert.strictEqual(report.nextActions[1].completed, false);
    });

    await runTest('Statistics generation', () => {
        const report = buildEnterpriseDeploymentReport({
            deploymentDiagnostics: {
                componentWarnings: [{}, {}],
                componentFailures: [{}]
            },
            failureClassification: {
                failures: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'A.B__c',
                        category: 'SAFE_SKIP',
                        reason: 'compatibility formula issue',
                        evidence: { source: 'COMPATIBILITY' }
                    },
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Helper',
                        category: 'INFORMATION',
                        reason: 'warning only'
                    }
                ],
                summary: { information: 1, manualAction: 0 }
            },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        resolutionType: 'DEPENDENCY'
                    },
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Gym__c',
                        resolutionType: 'PACKAGE'
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'A.B__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE'
                    },
                    {
                        resolutionType: 'INFORMATION'
                    }
                ],
                summary: { manualActions: 1, informational: 1 }
            },
            autoFixReport: {
                fixes: [
                    {
                        fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                        successful: true
                    },
                    { fixType: 'REGENERATE_PACKAGE', successful: true },
                    { fixType: 'REBUILD_WORKSPACE', successful: false }
                ]
            }
        });

        assert.strictEqual(report.statistics.dependencyFailures, 2);
        assert.strictEqual(report.statistics.compatibilityFailures, 1);
        assert.strictEqual(report.statistics.manualActions, 1);
        assert.strictEqual(report.statistics.autoResolved, 2);
        assert.strictEqual(report.statistics.warnings, 1);
    });
}

main();
