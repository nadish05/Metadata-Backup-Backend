const assert = require('assert');
const Module = require('module');

const {
    buildSupportBundle,
    generateBundleId,
    BUNDLE_VERSION,
    DISCLAIMER,
    ISSUE_SCOPE,
    PRODUCT_NAME
} = require('./supportBundle.service');

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

function baseValidation(overrides = {}) {
    return {
        historyId: 'HIST-100',
        deploymentId: '0Af5g00000BUNDLE1',
        validationCorrelationId: 'CORR-1',
        deploymentMode: 'VALIDATE',
        executionMode: 'VALIDATE',
        deploymentReadiness: { overallStatus: 'NOT_READY' },
        deploymentSummary: {
            deploymentStatus: 'Failed',
            durationMs: 1200,
            cliVersion: '2.50.0',
            cliCommandRedacted: 'sf project deploy start --target-org <redacted>'
        },
        packageSummary: {
            metadataCount: 2,
            dependencyCount: 1,
            membersByType: {
                ApexClass: ['Foo'],
                CustomField: ['Account.Score__c']
            }
        },
        failureClassification: {
            failures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    category: 'MANUAL_ACTION',
                    severity: 'HIGH',
                    reason: 'Formula type conversion is incompatible.',
                    errorCode: 'FIELD_INTEGRITY_EXCEPTION',
                    stage: 'CHECK_ONLY',
                    canSafeSkip: false,
                    safeToSkip: false
                },
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access',
                    category: 'MISSING_DEPENDENCY',
                    severity: 'HIGH',
                    reason: 'Referenced CustomObject missing.',
                    errorCode: 'MISSING_DEPENDENCY',
                    stage: 'DEPENDENCY',
                    canSafeSkip: null,
                    safeToSkip: null
                }
            ],
            summary: { total: 2 }
        },
        resolutionReport: {
            resolutions: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    resolutionType: 'MANUAL_ACTION',
                    userActionRequired: true,
                    autoFixAvailable: false,
                    safeSkipAvailable: false
                },
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access',
                    resolutionType: 'AUTO_FIXABLE',
                    userActionRequired: false,
                    autoFixAvailable: true,
                    safeSkipAvailable: false
                }
            ]
        },
        autoFixReport: {
            autoFixAvailable: true,
            autoFixApplied: false,
            fixes: []
        },
        autoValidationReport: {
            attempts: 1,
            autoValidationExecuted: false,
            initialStatus: 'FAILED',
            finalStatus: 'FAILED',
            revalidated: false,
            remainingFailures: 2
        },
        enterpriseDeploymentReport: {
            version: 1,
            overallStatus: 'FAILED',
            summary: { deploymentStatus: 'FAILED', executionMode: 'VALIDATE' },
            failures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    category: 'MANUAL_ACTION',
                    canSafeSkip: false
                },
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access',
                    category: 'MISSING_DEPENDENCY',
                    canSafeSkip: null
                }
            ],
            resolutions: [],
            autoFixes: []
        },
        deploymentDiagnostics: {
            deploymentId: '0Af5g00000BUNDLE1',
            overallStatus: 'Failed',
            summary: { failed: 2 },
            componentFailures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    message: 'Formula incompatible',
                    errorCode: 'FIELD_INTEGRITY_EXCEPTION',
                    stage: 'CHECK_ONLY'
                },
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access',
                    message: 'Missing dependency',
                    errorCode: 'MISSING_DEPENDENCY',
                    stage: 'DEPENDENCY'
                }
            ]
        },
        ...overrides
    };
}

async function main() {
    await runTest('successful validation bundle', () => {
        const sanitized = {
            historyId: 'HIST-OK',
            deploymentMode: 'VALIDATE',
            deploymentReadiness: { overallStatus: 'READY' },
            enterpriseDeploymentReport: { overallStatus: 'SUCCESS' },
            failureClassification: { failures: [], summary: { total: 0 } },
            resolutionReport: { resolutions: [] },
            autoFixReport: { autoFixApplied: false, fixes: [] },
            autoValidationReport: {
                attempts: 1,
                finalStatus: 'SUCCESS',
                revalidated: false
            },
            packageSummary: {
                metadataCount: 1,
                dependencyCount: 0,
                membersByType: { ApexClass: ['Ok'] }
            },
            deploymentDiagnostics: {
                deploymentId: '0AfOK',
                overallStatus: 'Succeeded',
                componentFailures: [],
                summary: {}
            }
        };

        const bundle = buildSupportBundle({ sanitizedValidationResult: sanitized });
        assert.strictEqual(bundle.bundleVersion, BUNDLE_VERSION);
        assert.strictEqual(bundle.status.overallStatus, 'SUCCESS');
        assert.strictEqual(bundle.status.enterpriseOverallStatus, 'SUCCESS');
        assert.strictEqual(bundle.failureClassification.failures.length, 0);
        assert.strictEqual(bundle.product.name, PRODUCT_NAME);
        assert.ok(bundle.product.version);
        assert.strictEqual(bundle.request.issueScope, ISSUE_SCOPE.ENTIRE_DEPLOYMENT);
    });

    await runTest('failed validation bundle', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(bundle.status.overallStatus, 'FAILED');
        assert.strictEqual(bundle.failureClassification.failures.length, 2);
        assert.strictEqual(bundle.salesforceOutcome.status, 'Failed');
    });

    await runTest('Formula failure', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Score__c',
                            category: 'MANUAL_ACTION',
                            reason: 'Formula type conversion is incompatible.',
                            errorCode: 'FIELD_INTEGRITY_EXCEPTION',
                            safeToSkip: false
                        }
                    ]
                }
            })
        });
        const failure = bundle.failureClassification.failures[0];
        assert.strictEqual(failure.metadataName, 'Account.Score__c');
        assert.ok(String(failure.reason).includes('Formula'));
        assert.strictEqual(failure.safeToSkip, false);
    });

    await runTest('PersonAccount failure', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'PersonAccount.PersonAccount',
                            category: 'DESTINATION_FEATURE',
                            reason: 'Person Accounts not enabled in destination.',
                            stage: 'DESTINATION_VALIDATION',
                            safeToSkip: false
                        }
                    ]
                },
                deploymentDiagnostics: {
                    componentFailures: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'PersonAccount.PersonAccount',
                            errorCode: 'INVALID_CROSS_REFERENCE_KEY',
                            stage: 'DESTINATION_VALIDATION'
                        }
                    ]
                }
            })
        });
        assert.strictEqual(
            bundle.failureClassification.failures[0].metadataName,
            'PersonAccount.PersonAccount'
        );
        assert.ok(bundle.reproHints.stages.includes('DESTINATION_VALIDATION'));
    });

    await runTest('missing dependency', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'Subscription_Access',
                            category: 'MISSING_DEPENDENCY',
                            stage: 'DEPENDENCY'
                        }
                    ]
                }
            })
        });
        assert.strictEqual(
            bundle.failureClassification.failures[0].category,
            'MISSING_DEPENDENCY'
        );
    });

    await runTest('auto-fixed dependency', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                autoFixReport: {
                    autoFixAvailable: true,
                    autoFixApplied: true,
                    fixes: [
                        {
                            metadataType: 'CustomObject',
                            metadataName: 'Subscription__c',
                            fixType: 'INCLUDE_DEPENDENCY',
                            action: 'INCLUDED',
                            executed: true,
                            successful: true
                        }
                    ]
                }
            })
        });
        assert.strictEqual(bundle.autoFixReport.autoFixApplied, true);
        assert.strictEqual(bundle.autoFixReport.fixes[0].successful, true);
    });

    await runTest('auto-validation report', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                autoValidationReport: {
                    attempts: 2,
                    autoValidationExecuted: true,
                    initialStatus: 'FAILED',
                    finalStatus: 'SUCCESS',
                    revalidated: true,
                    remainingFailures: 0
                }
            })
        });
        assert.strictEqual(bundle.autoValidationReport.attempts, 2);
        assert.strictEqual(bundle.autoValidationReport.revalidated, true);
        assert.strictEqual(bundle.autoValidationReport.finalStatus, 'SUCCESS');
    });

    await runTest('enterprise report included', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(bundle.enterpriseDeploymentReport.overallStatus, 'FAILED');
        assert.ok(Array.isArray(bundle.enterpriseDeploymentReport.failures));
    });

    await runTest('AI report present', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation(),
            aiResolutionReport: {
                generated: true,
                provider: 'gemini',
                fallbackUsed: false,
                summary: 'Manual formula correction required.',
                explanations: [{ metadataName: 'Account.Score__c' }],
                disclaimer: 'AI-generated / advisory only.',
                prompt: 'should-not-appear-in-builder-logic',
                apiKey: 'SECRET'
            }
        });
        assert.strictEqual(bundle.aiResolution.present, true);
        assert.strictEqual(bundle.aiResolution.advisoryOnly, true);
        assert.strictEqual(bundle.aiResolution.aiGenerated, true);
        assert.strictEqual(bundle.aiResolution.provider, 'gemini');
        assert.strictEqual(bundle.aiResolution.summary, 'Manual formula correction required.');
        assert.strictEqual(bundle.aiResolution.prompt, undefined);
        assert.strictEqual(bundle.aiResolution.apiKey, undefined);
    });

    await runTest('AI report absent', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                aiResolutionReport: { generated: false, summary: 'stub' }
            })
        });
        assert.deepStrictEqual(bundle.aiResolution, { present: false });
    });

    await runTest('selected failure', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation(),
            issueSelection: {
                scope: 'SELECTED_FAILURES',
                selectedFailures: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c'
                    }
                ]
            }
        });
        assert.strictEqual(bundle.request.issueScope, ISSUE_SCOPE.SELECTED_FAILURES);
        assert.strictEqual(bundle.request.selectedFailures.length, 1);
        assert.strictEqual(bundle.failureClassification.failures.length, 1);
        assert.strictEqual(
            bundle.failureClassification.failures[0].metadataName,
            'Account.Score__c'
        );
        assert.strictEqual(bundle.resolutionReport.resolutions.length, 1);
        assert.strictEqual(bundle.deploymentDiagnostics.componentFailures.length, 1);
        assert.strictEqual(bundle.enterpriseDeploymentReport.failures.length, 1);
    });

    await runTest('entire deployment', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation(),
            issueSelection: { scope: 'ENTIRE_DEPLOYMENT' }
        });
        assert.strictEqual(bundle.request.issueScope, ISSUE_SCOPE.ENTIRE_DEPLOYMENT);
        assert.strictEqual(bundle.failureClassification.failures.length, 2);
    });

    await runTest('invalid selected failure ignored by builder', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation(),
            issueSelection: {
                scope: 'SELECTED_FAILURES',
                selectedFailures: [
                    { metadataType: 'ApexClass', metadataName: 'DoesNotExist' }
                ]
            }
        });
        // No valid matches → entire deployment snapshot
        assert.strictEqual(bundle.request.issueScope, ISSUE_SCOPE.ENTIRE_DEPLOYMENT);
        assert.deepStrictEqual(bundle.request.selectedFailures, []);
        assert.strictEqual(bundle.failureClassification.failures.length, 2);
    });

    await runTest('bundle ID format', () => {
        const id = generateBundleId(new Date('2026-08-10T06:30:00.000Z'));
        assert.match(id, /^SUP-20260810-[0-9A-F]{6}$/);
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation(),
            generatedAt: '2026-08-10T06:30:00.000Z'
        });
        assert.match(bundle.bundleId, /^SUP-20260810-[0-9A-F]{6}$/);
    });

    await runTest('unique bundle IDs', () => {
        const a = buildSupportBundle({ sanitizedValidationResult: baseValidation() });
        const b = buildSupportBundle({ sanitizedValidationResult: baseValidation() });
        assert.notStrictEqual(a.bundleId, b.bundleId);
    });

    await runTest('ISO generatedAt', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation(),
            generatedAt: '2026-08-10T06:30:00.000Z'
        });
        assert.strictEqual(bundle.generatedAt, '2026-08-10T06:30:00.000Z');
        const live = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.ok(!Number.isNaN(Date.parse(live.generatedAt)));
        assert.ok(live.generatedAt.endsWith('Z') || live.generatedAt.includes('T'));
    });

    await runTest('existing historyId preserved', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(bundle.correlation.historyId, 'HIST-100');
    });

    await runTest('existing deploymentId preserved', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(bundle.correlation.deploymentId, '0Af5g00000BUNDLE1');
    });

    await runTest('missing identifiers', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: {
                failureClassification: { failures: [] }
            }
        });
        assert.strictEqual(bundle.correlation.historyId, null);
        assert.strictEqual(bundle.correlation.deploymentId, null);
        assert.ok(bundle.bundleId.startsWith('SUP-'));
    });

    await runTest('missing reports', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: {}
        });
        assert.deepStrictEqual(bundle.failureClassification, {});
        assert.deepStrictEqual(bundle.resolutionReport, {});
        assert.deepStrictEqual(bundle.autoFixReport, {});
        assert.deepStrictEqual(bundle.autoValidationReport, {});
        assert.deepStrictEqual(bundle.enterpriseDeploymentReport, {});
        assert.deepStrictEqual(bundle.deploymentDiagnostics, {});
    });

    await runTest('empty diagnostics', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: {
                deploymentDiagnostics: {}
            }
        });
        assert.strictEqual(bundle.deploymentDiagnostics.deploymentId, null);
        assert.deepStrictEqual(bundle.deploymentDiagnostics.componentFailures, []);
    });

    await runTest('null values', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: null
        });
        assert.strictEqual(bundle.status.overallStatus, null);
        assert.strictEqual(bundle.selectionSummary.metadataCount, null);
        assert.strictEqual(bundle.selectionSummary.dependencyCount, null);
        assert.deepStrictEqual(bundle.aiResolution, { present: false });
    });

    await runTest('safeToSkip true preserved', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: {
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'Layout',
                            metadataName: 'Account-Layout',
                            safeToSkip: true,
                            canSafeSkip: true
                        }
                    ]
                }
            }
        });
        assert.strictEqual(bundle.failureClassification.failures[0].safeToSkip, true);
        assert.strictEqual(bundle.safeToSkipHints.items[0].safeToSkip, true);
    });

    await runTest('safeToSkip false preserved', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        const formula = bundle.failureClassification.failures.find(
            (f) => f.metadataName === 'Account.Score__c'
        );
        assert.strictEqual(formula.safeToSkip, false);
        const hint = bundle.safeToSkipHints.items.find(
            (i) => i.metadataName === 'Account.Score__c'
        );
        assert.strictEqual(hint.safeToSkip, false);
    });

    await runTest('safeToSkip null preserved', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        const dep = bundle.failureClassification.failures.find(
            (f) => f.metadataName === 'Subscription_Access'
        );
        assert.strictEqual(dep.safeToSkip, null);
        const hint = bundle.safeToSkipHints.items.find(
            (i) => i.metadataName === 'Subscription_Access'
        );
        assert.strictEqual(hint.safeToSkip, null);
    });

    await runTest('no AI call', () => {
        const forbidden = [
            'openai',
            '@google/genai',
            './aiDeploymentAdvisor.service',
            '../aiDeploymentAdvisor/aiDeploymentAdvisor.service'
        ];
        const loaded = Object.keys(require.cache).join('\n');
        // Builder module must not pull AI provider clients when building
        const builderPath = require.resolve('./supportBundle.service');
        const children = Module._cache[builderPath]?.children || [];
        const childIds = children.map((c) => c.id || c.filename || '');
        for (const needle of forbidden) {
            assert.ok(
                !childIds.some((id) => id.includes(needle)),
                `Builder unexpectedly loaded ${needle}`
            );
        }
        buildSupportBundle({
            sanitizedValidationResult: baseValidation(),
            aiResolutionReport: { generated: true, provider: 'gemini', summary: 'x' }
        });
        void loaded;
    });

    await runTest('no deployment call', () => {
        const builderPath = require.resolve('./supportBundle.service');
        const children = Module._cache[builderPath]?.children || [];
        const childIds = children.map((c) => c.id || c.filename || '');
        const forbidden = [
            'deploymentValidation.service',
            'deploymentExecution',
            'checkOnlyDeployment.service',
            'deploymentAutoFix.service',
            'deploymentAutoValidation.service'
        ];
        for (const needle of forbidden) {
            assert.ok(
                !childIds.some((id) => id.includes(needle)),
                `Builder unexpectedly loaded ${needle}`
            );
        }
    });

    await runTest('no mutation of input', () => {
        const sanitized = baseValidation();
        const issueSelection = {
            scope: 'SELECTED_FAILURES',
            selectedFailures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c'
                }
            ]
        };
        const aiResolutionReport = {
            generated: true,
            provider: 'openai',
            summary: 'advisory'
        };
        const snapSanitized = JSON.parse(JSON.stringify(sanitized));
        const snapSelection = JSON.parse(JSON.stringify(issueSelection));
        const snapAi = JSON.parse(JSON.stringify(aiResolutionReport));

        buildSupportBundle({
            sanitizedValidationResult: sanitized,
            issueSelection,
            aiResolutionReport
        });

        assert.deepStrictEqual(sanitized, snapSanitized);
        assert.deepStrictEqual(issueSelection, snapSelection);
        assert.deepStrictEqual(aiResolutionReport, snapAi);
    });

    await runTest('no raw CLI output', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                deploymentDiagnostics: {
                    deploymentId: '0Af',
                    overallStatus: 'Failed',
                    cliStdout: 'SHOULD_NOT_APPEAR',
                    cliStderr: 'SHOULD_NOT_APPEAR',
                    rawFailure: { dump: true },
                    componentFailures: []
                }
            })
        });
        assert.strictEqual(bundle.deploymentDiagnostics.cliStdout, undefined);
        assert.strictEqual(bundle.deploymentDiagnostics.cliStderr, undefined);
        assert.strictEqual(bundle.deploymentDiagnostics.rawFailure, undefined);
        const text = JSON.stringify(bundle);
        assert.ok(!text.includes('SHOULD_NOT_APPEAR'));
    });

    await runTest('no source code', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                sourceCode: 'public class Foo {}',
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'Foo',
                            sourceCode: 'leak'
                        }
                    ]
                }
            })
        });
        assert.strictEqual(bundle.sourceCode, undefined);
        assert.strictEqual(bundle.failureClassification.failures[0].sourceCode, 'leak');
        // Builder snapshots classification as provided (sanitizer already strips source).
        // Ensure top-level bundle does not add source fields.
        assert.ok(!Object.prototype.hasOwnProperty.call(bundle, 'sourceCode'));
        assert.ok(!Object.prototype.hasOwnProperty.call(bundle, 'apexSource'));
    });

    await runTest('no package.xml', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation({
                packageXml: '<Package/>',
                generatedManifest: { packageXml: '<Package/>' }
            })
        });
        assert.ok(!Object.prototype.hasOwnProperty.call(bundle, 'packageXml'));
        const text = JSON.stringify(bundle);
        assert.ok(!text.includes('<Package/>'));
        assert.strictEqual(bundle.selectionSummary.metadataCount, 2);
    });

    await runTest('disclaimer present', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(bundle.disclaimer, DISCLAIMER);
    });

    await runTest('sanitization marker present', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(bundle.sanitization.applied, true);
        assert.strictEqual(bundle.sanitization.version, 1);
    });

    await runTest('selection summary from packageSummary', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(bundle.selectionSummary.metadataCount, 2);
        assert.strictEqual(bundle.selectionSummary.dependencyCount, 1);
        assert.deepStrictEqual(bundle.selectionSummary.membersByType.ApexClass, ['Foo']);
    });

    await runTest('salesforce outcome uses redacted command only', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: baseValidation()
        });
        assert.strictEqual(
            bundle.salesforceOutcome.cliCommandRedacted,
            'sf project deploy start --target-org <redacted>'
        );
        assert.strictEqual(bundle.salesforceOutcome.cliVersion, '2.50.0');
        assert.ok(!Object.prototype.hasOwnProperty.call(bundle.salesforceOutcome, 'cliCommand'));
    });

    if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
    }
}

main();
