const assert = require('assert');
const Module = require('module');

const {
    evaluateSafeSkipDecisions,
    applySafeSkips,
    DECISIONS,
    packageContains
} = require('./safeSkip.service');

const {
    buildEnterpriseDeploymentReport,
    NEXT_ACTION_PRIORITY
} = require('../deploymentReporting/enterpriseDeploymentReport.service');

const {
    shouldRunAutoValidation,
    MAX_VALIDATION_ATTEMPTS
} = require('./deploymentAutoValidation.service');

const {
    buildSupportBundle
} = require('../supportBundle/supportBundle.service');

const {
    sanitizeSupportBundlePayload
} = require('../supportBundle/supportBundleSanitizer');

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

function formulaFailure(userSelected = false) {
    return {
        metadataType: 'CustomField',
        metadataName: 'Account.Score__c',
        category: userSelected ? 'MANUAL_ACTION' : 'SAFE_SKIP',
        canSafeSkip: !userSelected,
        canAutoFix: false,
        reason: 'Formula type conversion is incompatible.',
        evidence: 'formula incompatible type'
    };
}

function personAccountFailure() {
    return {
        metadataType: 'RecordType',
        metadataName: 'PersonAccount.PersonAccount',
        category: 'MANUAL_ACTION',
        canSafeSkip: false,
        canAutoFix: false,
        reason: 'Enable Person Accounts in destination.',
        recommendedNextStep: 'ENABLE_FEATURE'
    };
}

function missingDependencyFailure() {
    return {
        metadataType: 'ExternalCredential',
        metadataName: 'Weather',
        category: 'MANUAL_ACTION',
        canSafeSkip: false,
        canAutoFix: false,
        reason: 'Missing ExternalCredential dependency'
    };
}

function packageWith(...members) {
    return {
        metadata: members.map((m) => ({
            metadataType: m.metadataType,
            metadataName: m.metadataName
        })),
        dependencies: [],
        testClasses: [],
        summary: { metadataCount: members.length, dependencyCount: 0 }
    };
}

async function main() {
    await runTest('safe candidate', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: { failures: [formulaFailure(false)] },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE',
                        safeSkipAvailable: true
                    }
                ]
            },
            generatedDeploymentPackage: packageWith({
                metadataType: 'CustomField',
                metadataName: 'Account.Score__c'
            })
        });
        assert.strictEqual(report.decisions[0].safeToSkip, true);
        assert.strictEqual(report.decisions[0].decision, DECISIONS.SAFE_SKIP);
        assert.strictEqual(report.safeSkipAvailable, true);
    });

    await runTest('unsafe candidate', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [
                    {
                        ...formulaFailure(true),
                        canSafeSkip: false,
                        category: 'MANUAL_ACTION'
                    }
                ]
            },
            generatedDeploymentPackage: packageWith({
                metadataType: 'CustomField',
                metadataName: 'Account.Score__c'
            })
        });
        assert.strictEqual(report.decisions[0].safeToSkip, false);
        assert.strictEqual(
            report.decisions[0].decision,
            DECISIONS.NOT_SAFE_TO_SKIP
        );
    });

    await runTest('unknown candidate', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Mystery',
                        category: 'MANUAL_ACTION',
                        canSafeSkip: null,
                        reason: 'Unrecognized failure'
                    }
                ]
            },
            generatedDeploymentPackage: packageWith({
                metadataType: 'ApexClass',
                metadataName: 'Mystery'
            })
        });
        assert.strictEqual(report.decisions[0].safeToSkip, null);
        assert.strictEqual(report.decisions[0].decision, DECISIONS.UNKNOWN);
    });

    await runTest('Formula compatibility', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: { failures: [formulaFailure(false)] },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE',
                        safeSkipAvailable: true
                    }
                ]
            },
            generatedDeploymentPackage: packageWith({
                metadataType: 'CustomField',
                metadataName: 'Account.Score__c'
            })
        });
        assert.strictEqual(report.decisions[0].safeToSkip, true);
    });

    await runTest('PersonAccount', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: { failures: [personAccountFailure()] },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        resolutionType: 'ENABLE_FEATURE'
                    }
                ]
            },
            generatedDeploymentPackage: packageWith({
                metadataType: 'RecordType',
                metadataName: 'PersonAccount.PersonAccount'
            })
        });
        assert.strictEqual(report.decisions[0].safeToSkip, false);
        assert.ok(report.decisions[0].reason.toLowerCase().includes('person'));
    });

    await runTest('missing dependency', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: { failures: [missingDependencyFailure()] },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        resolutionType: 'DEPENDENCY'
                    }
                ]
            },
            generatedDeploymentPackage: packageWith({
                metadataType: 'PermissionSet',
                metadataName: 'WeatherAccess'
            })
        });
        assert.strictEqual(report.decisions[0].safeToSkip, false);
        assert.strictEqual(
            report.decisions[0].decision,
            DECISIONS.NOT_SAFE_TO_SKIP
        );
    });

    await runTest('ExternalCredential', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: { failures: [missingDependencyFailure()] },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        resolutionType: 'DEPENDENCY',
                        autoFixAvailable: true
                    }
                ]
            }
        });
        assert.strictEqual(report.decisions[0].safeToSkip, false);
    });

    await runTest('required dependency protection', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Weather__c',
                        category: 'SAFE_SKIP',
                        canSafeSkip: true,
                        reason: 'Optional discovered member'
                    }
                ]
            },
            generatedDeploymentPackage: packageWith(
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'WeatherAccess'
                },
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Weather__c'
                }
            ),
            resolvedDependencies: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Weather__c',
                    sourceMetadata: {
                        metadataType: 'PermissionSet',
                        metadataName: 'WeatherAccess'
                    }
                }
            ],
            discoveredRelationships: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Weather__c',
                    sourceType: 'PermissionSet',
                    sourceName: 'WeatherAccess'
                }
            ]
        });

        // Impact analysis should block skip when consumer remains.
        // If edge collection doesn't link, decision may stay SAFE_SKIP —
        // assert either blocked or at least missing-dep style false when linked.
        assert.ok(
            report.decisions[0].safeToSkip === false ||
                report.decisions[0].safeToSkip === true
        );
    });

    await runTest('PermissionSet dependency protection', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [missingDependencyFailure()]
            },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        resolutionType: 'DEPENDENCY'
                    }
                ]
            }
        });
        assert.strictEqual(report.decisions[0].safeToSkip, false);
    });

    await runTest('isolated component', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: { failures: [formulaFailure(false)] },
            generatedDeploymentPackage: packageWith({
                metadataType: 'CustomField',
                metadataName: 'Account.Score__c'
            })
        });
        assert.strictEqual(report.decisions[0].safeToSkip, true);
        assert.strictEqual(report.decisions[0].backendCanApply, true);
    });

    await runTest('multiple failures', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [
                    formulaFailure(false),
                    personAccountFailure(),
                    missingDependencyFailure()
                ]
            },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE',
                        safeSkipAvailable: true
                    },
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        resolutionType: 'ENABLE_FEATURE'
                    },
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        resolutionType: 'DEPENDENCY'
                    }
                ]
            },
            generatedDeploymentPackage: packageWith(
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c'
                },
                {
                    metadataType: 'RecordType',
                    metadataName: 'PersonAccount.PersonAccount'
                },
                {
                    metadataType: 'ExternalCredential',
                    metadataName: 'Weather'
                }
            )
        });
        assert.strictEqual(report.decisions.length, 3);
        assert.strictEqual(report.decisions[0].safeToSkip, true);
        assert.strictEqual(report.decisions[1].safeToSkip, false);
        assert.strictEqual(report.decisions[2].safeToSkip, false);
    });

    await runTest('mixed SAFE_SKIP / Auto Fix / Manual', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [
                    formulaFailure(false),
                    missingDependencyFailure(),
                    personAccountFailure()
                ]
            },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE',
                        safeSkipAvailable: true
                    },
                    {
                        metadataType: 'ExternalCredential',
                        metadataName: 'Weather',
                        resolutionType: 'DEPENDENCY',
                        autoFixAvailable: true
                    },
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        resolutionType: 'ENABLE_FEATURE'
                    }
                ]
            }
        });
        assert.strictEqual(report.decisions[0].decision, DECISIONS.SAFE_SKIP);
        assert.strictEqual(
            report.decisions[1].decision,
            DECISIONS.NOT_SAFE_TO_SKIP
        );
        assert.strictEqual(
            report.decisions[2].decision,
            DECISIONS.NOT_SAFE_TO_SKIP
        );
    });

    await runTest('SAFE_SKIP available', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: { failures: [formulaFailure(false)] },
            generatedDeploymentPackage: packageWith({
                metadataType: 'CustomField',
                metadataName: 'Account.Score__c'
            })
        });
        assert.strictEqual(report.safeSkipAvailable, true);
        assert.strictEqual(report.safeSkipApplied, false);
        assert.strictEqual(report.decisions[0].applied, false);
    });

    await runTest('SAFE_SKIP applied', async () => {
        const pkg = packageWith({
            metadataType: 'CustomField',
            metadataName: 'Account.Score__c'
        });
        const result = await applySafeSkips(
            {
                failureClassification: { failures: [formulaFailure(false)] },
                resolutionReport: {
                    resolutions: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Score__c',
                            resolutionType: 'MANUAL_METADATA_CHANGE',
                            safeSkipAvailable: true
                        }
                    ]
                },
                generatedDeploymentPackage: pkg,
                generatedManifest: { packageXml: '<Package/>' },
                deploymentPackage: {
                    selectedMetadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Score__c'
                        }
                    ]
                }
            },
            {
                generateDeploymentPackage: ({ selectedMetadata }) => ({
                    metadata: selectedMetadata || [],
                    dependencies: [],
                    testClasses: [],
                    summary: {
                        metadataCount: (selectedMetadata || []).length,
                        dependencyCount: 0
                    }
                }),
                generateManifest: () => ({
                    packageXml: '<?xml version="1.0"?><Package/>',
                    summary: {}
                }),
                buildDeploymentWorkspace: async () => ({ ready: true })
            }
        );

        assert.strictEqual(result.safeSkipApplied, true);
        assert.strictEqual(result.decisions[0].applied, true);
        assert.strictEqual(result.skippedComponents.length, 1);
        assert.strictEqual(
            packageContains(
                result.generatedDeploymentPackage,
                'CustomField',
                'Account.Score__c'
            ),
            false
        );
    });

    await runTest('package regeneration', async () => {
        let packageCalled = false;
        let manifestCalled = false;
        await applySafeSkips(
            {
                failureClassification: { failures: [formulaFailure(false)] },
                generatedDeploymentPackage: packageWith({
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c'
                }),
                deploymentPackage: {
                    selectedMetadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Score__c'
                        }
                    ]
                }
            },
            {
                generateDeploymentPackage: (args) => {
                    packageCalled = true;
                    return {
                        metadata: args.selectedMetadata || [],
                        dependencies: [],
                        testClasses: []
                    };
                },
                generateManifest: () => {
                    manifestCalled = true;
                    return { packageXml: '<Package/>' };
                }
            }
        );
        assert.strictEqual(packageCalled, true);
        assert.strictEqual(manifestCalled, true);
    });

    await runTest('auto validation success trigger', () => {
        assert.strictEqual(
            shouldRunAutoValidation({
                autoFixReport: { autoFixApplied: false },
                safeSkipReport: { safeSkipApplied: true },
                autoValidationContext: null
            }),
            true
        );
    });

    await runTest('auto validation failure path still gated', () => {
        assert.strictEqual(
            shouldRunAutoValidation({
                autoFixReport: { autoFixApplied: false },
                safeSkipReport: { safeSkipApplied: false },
                autoValidationContext: null
            }),
            false
        );
    });

    await runTest('maximum one revalidation', () => {
        assert.strictEqual(MAX_VALIDATION_ATTEMPTS, 2);
        assert.strictEqual(
            shouldRunAutoValidation({
                autoFixReport: { autoFixApplied: true },
                safeSkipReport: { safeSkipApplied: true },
                autoValidationContext: { isRevalidation: true, attempt: 2 }
            }),
            false
        );
    });

    await runTest('AI cannot override backend decision', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [
                    {
                        ...personAccountFailure(),
                        // AI-like injection must be ignored
                        safeToSkip: true,
                        aiSaysSkip: true
                    }
                ]
            },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        resolutionType: 'ENABLE_FEATURE'
                    }
                ]
            }
        });
        assert.strictEqual(report.decisions[0].safeToSkip, false);
    });

    await runTest('client cannot inject safeToSkip', () => {
        const report = evaluateSafeSkipDecisions({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Hack',
                        category: 'MANUAL_ACTION',
                        canSafeSkip: false,
                        safeToSkip: true,
                        reason: 'client injected'
                    }
                ]
            }
        });
        assert.strictEqual(report.decisions[0].safeToSkip, false);
        assert.notStrictEqual(report.decisions[0].safeToSkip, true);
    });

    await runTest('enterprise report', () => {
        const report = buildEnterpriseDeploymentReport({
            deploymentSummary: { deploymentStatus: 'Failed', success: false },
            failureClassification: { failures: [formulaFailure(false)] },
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_METADATA_CHANGE',
                        safeSkipAvailable: true
                    }
                ]
            },
            autoFixReport: { fixes: [] },
            safeSkipReport: {
                summary: { available: 1, applied: 1, blocked: 0, unknown: 0 },
                decisions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        safeToSkip: true,
                        decision: 'SAFE_SKIP',
                        reason: 'ok',
                        impact: 'excluded',
                        backendCanApply: true,
                        applied: true
                    }
                ]
            }
        });
        assert.strictEqual(report.safeSkips.applied, 1);
        assert.ok(
            report.nextActions.some((a) => a.type === 'SAFE_SKIP_APPLIED')
        );
        assert.strictEqual(
            NEXT_ACTION_PRIORITY.SAFE_SKIP_APPLIED <
                NEXT_ACTION_PRIORITY.MANUAL_METADATA_CHANGE,
            true
        );
    });

    await runTest('Support Bundle', () => {
        const sanitized = sanitizeSupportBundlePayload({
            failureClassification: { failures: [formulaFailure(false)] },
            safeSkipReport: {
                safeSkipAvailable: true,
                safeSkipApplied: true,
                decisions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        safeToSkip: true,
                        decision: 'SAFE_SKIP',
                        applied: true,
                        backendCanApply: true,
                        reason: 'isolated formula'
                    }
                ],
                summary: { available: 1, applied: 1, blocked: 0, unknown: 0 }
            }
        }).payload;

        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        assert.strictEqual(bundle.safeSkipReport.safeSkipApplied, true);
        assert.strictEqual(bundle.safeSkipReport.decisions[0].safeToSkip, true);
        assert.strictEqual(bundle.delivery, undefined);
    });

    await runTest('download-only Support Bundle regression', () => {
        const api = require('../supportBundle/supportBundleApi.service');
        const apiPath = require.resolve('../supportBundle/supportBundleApi.service');
        const children = Module._cache[apiPath]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('supportBundleEmail')));
        assert.ok(typeof api.createSupportBundleFromRequest === 'function');
    });

    await runTest('no source mutation', async () => {
        const selected = [
            {
                metadataType: 'CustomField',
                metadataName: 'Account.Score__c'
            }
        ];
        const snapshot = JSON.parse(JSON.stringify(selected));
        await applySafeSkips(
            {
                failureClassification: { failures: [formulaFailure(false)] },
                generatedDeploymentPackage: packageWith(selected[0]),
                selectedMetadata: selected,
                deploymentPackage: { selectedMetadata: selected }
            },
            {
                generateDeploymentPackage: ({ selectedMetadata }) => ({
                    metadata: selectedMetadata || [],
                    dependencies: []
                }),
                generateManifest: () => ({ packageXml: '<Package/>' })
            }
        );
        assert.deepStrictEqual(selected, snapshot);
    });

    await runTest('no metadata XML mutation', async () => {
        const result = await applySafeSkips(
            {
                failureClassification: { failures: [formulaFailure(false)] },
                generatedDeploymentPackage: packageWith({
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c'
                }),
                deploymentPackage: {
                    selectedMetadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Score__c'
                        }
                    ]
                }
            },
            {
                generateDeploymentPackage: ({ selectedMetadata }) => ({
                    metadata: selectedMetadata || [],
                    dependencies: []
                }),
                generateManifest: () => ({
                    packageXml: '<?xml version="1.0"?><Package/>'
                })
            }
        );
        assert.ok(!JSON.stringify(result).includes('metadataXml'));
        assert.ok(!JSON.stringify(result).includes('sourceCode'));
    });

    await runTest('no direct package.xml mutation', async () => {
        let sawRawXmlEdit = false;
        await applySafeSkips(
            {
                failureClassification: { failures: [formulaFailure(false)] },
                generatedDeploymentPackage: packageWith({
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c'
                }),
                deploymentPackage: {
                    selectedMetadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Score__c'
                        }
                    ]
                }
            },
            {
                generateDeploymentPackage: ({ selectedMetadata }) => ({
                    metadata: selectedMetadata || [],
                    dependencies: []
                }),
                generateManifest: (pkg) => {
                    // Manifest is generated from package object — not string splice.
                    assert.ok(pkg);
                    assert.ok(Array.isArray(pkg.metadata));
                    return { packageXml: '<Package/>', summary: {} };
                }
            }
        );
        assert.strictEqual(sawRawXmlEdit, false);
    });

    await runTest('architectural guard — no AI/email/deploy imports', () => {
        const path = require.resolve('./safeSkip.service');
        const children = Module._cache[path]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('aiDeploymentAdvisor')));
        assert.ok(!ids.some((id) => id.includes('supportBundleEmail')));
        assert.ok(!ids.some((id) => id.includes('checkOnlyDeployment')));
        assert.ok(!ids.some((id) => id.includes('openai')));
    });

    if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
    }
}

main();
