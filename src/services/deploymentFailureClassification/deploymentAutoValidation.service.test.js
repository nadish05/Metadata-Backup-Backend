const assert = require('assert');

const {
    MAX_VALIDATION_ATTEMPTS,
    isAutoValidationReentry,
    shouldRunAutoValidation,
    countAutoFixesApplied,
    deriveValidationStatus,
    buildRevalidationPackage,
    buildAutoValidationReport,
    completeWithAutoValidationLoop
} = require('./deploymentAutoValidation.service');

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
    await runTest(
        'Auto fix available → second validation succeeds',
        async () => {
            let validationCalls = 0;

            const initialResponse = {
                checkOnlyDeployment: { success: false, status: 'FAILED' },
                failureClassification: {
                    failures: [{ key: 'ApexClass:Helper', category: 'MANUAL_ACTION' }]
                },
                resolutionReport: { resolutions: [{ resolutionType: 'DEPENDENCY' }] },
                autoFixReport: {
                    autoFixAvailable: true,
                    autoFixApplied: true,
                    fixes: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'Helper',
                            fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                            executed: true,
                            successful: true
                        },
                        {
                            fixType: 'REGENERATE_PACKAGE',
                            executed: true,
                            successful: true
                        },
                        {
                            fixType: 'REBUILD_WORKSPACE',
                            executed: true,
                            successful: true
                        }
                    ]
                }
            };

            const final = await completeWithAutoValidationLoop({
                initialResponse,
                autoFixResult: {
                    autoFixApplied: true,
                    generatedDeploymentPackage: {
                        metadata: [
                            {
                                metadataType: 'PermissionSet',
                                metadataName: 'Gym_Trainer'
                            },
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'Helper'
                            }
                        ]
                    }
                },
                autoValidationContext: null,
                deploymentPackage: {
                    selectedMetadata: [
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'Gym_Trainer'
                        }
                    ],
                    deploymentMode: 'DEPLOY',
                    executeDeployment: true
                },
                validationArgs: {
                    refreshToken: 'rt',
                    instanceUrl: 'https://example.com',
                    orgId: '00D'
                },
                runValidation: async (args) => {
                    validationCalls += 1;
                    assert.strictEqual(args.autoValidationContext.isRevalidation, true);
                    assert.strictEqual(args.deploymentPackage.deploymentMode, 'VALIDATE');
                    assert.strictEqual(args.deploymentPackage.executeDeployment, false);
                    assert.ok(
                        args.deploymentPackage.selectedMetadata.some(
                            (item) =>
                                item.metadataType === 'ApexClass' &&
                                item.metadataName === 'Helper'
                        )
                    );

                    return {
                        checkOnlyDeployment: { success: true, status: 'SUCCESS' },
                        failureClassification: { failures: [], summary: {} },
                        resolutionReport: { resolutions: [], summary: {} },
                        autoFixReport: {
                            autoFixAvailable: false,
                            autoFixApplied: false,
                            fixes: []
                        }
                    };
                }
            });

            assert.strictEqual(validationCalls, 1);
            assert.strictEqual(final.checkOnlyDeployment.success, true);
            assert.strictEqual(final.autoFixReport.autoFixApplied, true);
            assert.strictEqual(final.autoFixReport.fixes.length, 3);
            assert.ok(final.failureClassification);
            assert.ok(final.resolutionReport);
            assert.strictEqual(final.autoValidationReport.attempts, 2);
            assert.strictEqual(final.autoValidationReport.autoValidationExecuted, true);
            assert.strictEqual(final.autoValidationReport.initialStatus, 'FAILED');
            assert.strictEqual(final.autoValidationReport.finalStatus, 'SUCCESS');
            assert.strictEqual(final.autoValidationReport.autoFixesApplied, 3);
            assert.strictEqual(final.autoValidationReport.revalidated, true);
            assert.strictEqual(
                final.autoValidationReport.remainingFailures,
                undefined
            );
        }
    );

    await runTest(
        'Auto fix available → second validation still fails',
        async () => {
            const initialResponse = {
                checkOnlyDeployment: { success: false, status: 'FAILED' },
                failureClassification: {
                    failures: [{ key: 'Flow:X', category: 'MANUAL_ACTION' }]
                },
                resolutionReport: { resolutions: [] },
                autoFixReport: {
                    autoFixAvailable: true,
                    autoFixApplied: true,
                    fixes: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'X',
                            fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                            successful: true
                        }
                    ]
                }
            };

            const final = await completeWithAutoValidationLoop({
                initialResponse,
                autoFixResult: {
                    autoFixApplied: true,
                    generatedDeploymentPackage: {
                        metadata: [
                            { metadataType: 'Flow', metadataName: 'X' }
                        ]
                    }
                },
                deploymentPackage: { selectedMetadata: [] },
                validationArgs: {},
                runValidation: async () => ({
                    checkOnlyDeployment: { success: false, status: 'FAILED' },
                    failureClassification: {
                        failures: [
                            {
                                key: 'RecordType:PersonAccount',
                                category: 'MANUAL_ACTION',
                                reason: 'Person Accounts required'
                            }
                        ]
                    },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: {
                        autoFixAvailable: false,
                        autoFixApplied: false,
                        fixes: []
                    }
                })
            });

            assert.strictEqual(final.autoValidationReport.attempts, 2);
            assert.strictEqual(final.autoValidationReport.autoValidationExecuted, true);
            assert.strictEqual(final.autoValidationReport.finalStatus, 'FAILED');
            assert.strictEqual(final.autoValidationReport.revalidated, true);
            assert.ok(Array.isArray(final.autoValidationReport.remainingFailures));
            assert.strictEqual(
                final.autoValidationReport.remainingFailures.length,
                1
            );
            assert.strictEqual(final.autoFixReport.autoFixApplied, true);
            assert.ok(final.failureClassification);
            assert.ok(final.resolutionReport);
        }
    );

    await runTest('No auto fixes → no second validation', async () => {
        let validationCalls = 0;

        const initialResponse = {
            checkOnlyDeployment: { success: false, status: 'FAILED' },
            failureClassification: { failures: [{ key: 'A:B' }] },
            resolutionReport: { resolutions: [] },
            autoFixReport: {
                autoFixAvailable: false,
                autoFixApplied: false,
                fixes: []
            }
        };

        const final = await completeWithAutoValidationLoop({
            initialResponse,
            autoFixResult: { autoFixApplied: false },
            deploymentPackage: {},
            runValidation: async () => {
                validationCalls += 1;
                return {};
            }
        });

        assert.strictEqual(validationCalls, 0);
        assert.strictEqual(final, initialResponse);
        assert.strictEqual(final.autoValidationReport.attempts, 1);
        assert.strictEqual(final.autoValidationReport.autoValidationExecuted, false);
        assert.strictEqual(final.autoValidationReport.revalidated, false);
        assert.strictEqual(final.autoValidationReport.autoFixesApplied, 0);
    });

    await runTest('Auto fix report empty → no second validation', async () => {
        let validationCalls = 0;

        const initialResponse = {
            checkOnlyDeployment: { success: true, status: 'SUCCESS' },
            autoFixReport: {
                autoFixAvailable: false,
                autoFixApplied: false,
                fixes: []
            }
        };

        const final = await completeWithAutoValidationLoop({
            initialResponse,
            autoFixResult: null,
            deploymentPackage: {},
            runValidation: async () => {
                validationCalls += 1;
                return { checkOnlyDeployment: { success: true } };
            }
        });

        assert.strictEqual(validationCalls, 0);
        assert.strictEqual(final.autoValidationReport.autoValidationExecuted, false);
        assert.deepStrictEqual(final.autoFixReport.fixes, []);
    });

    await runTest('Ensure only one automatic validation occurs', async () => {
        let validationCalls = 0;

        await completeWithAutoValidationLoop({
            initialResponse: {
                checkOnlyDeployment: { success: false },
                autoFixReport: {
                    autoFixAvailable: true,
                    autoFixApplied: true,
                    fixes: [
                        {
                            fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                            successful: true
                        }
                    ]
                }
            },
            autoFixResult: {
                autoFixApplied: true,
                generatedDeploymentPackage: {
                    metadata: [
                        { metadataType: 'ApexClass', metadataName: 'A' }
                    ]
                }
            },
            deploymentPackage: {},
            runValidation: async (args) => {
                validationCalls += 1;

                // Simulate nested loop attempt: even if called again with
                // revalidation context, shouldRun must stay false.
                assert.strictEqual(
                    shouldRunAutoValidation({
                        autoFixReport: {
                            autoFixApplied: true,
                            fixes: [
                                {
                                    fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                                    successful: true
                                }
                            ]
                        },
                        autoValidationContext: args.autoValidationContext
                    }),
                    false
                );

                return {
                    checkOnlyDeployment: { success: true },
                    failureClassification: { failures: [] },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: {
                        autoFixAvailable: false,
                        autoFixApplied: false,
                        fixes: []
                    }
                };
            }
        });

        assert.strictEqual(validationCalls, 1);
        assert.strictEqual(MAX_VALIDATION_ATTEMPTS, 2);
    });

    await runTest('Guard against recursive execution', async () => {
        let validationCalls = 0;

        assert.strictEqual(
            isAutoValidationReentry({ isRevalidation: true, attempt: 2 }),
            true
        );
        assert.strictEqual(
            shouldRunAutoValidation({
                autoFixReport: { autoFixApplied: true },
                autoValidationContext: { isRevalidation: true, attempt: 2 }
            }),
            false
        );

        const initialResponse = {
            checkOnlyDeployment: { success: false },
            autoFixReport: {
                autoFixAvailable: true,
                autoFixApplied: true,
                fixes: [
                    {
                        fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                        successful: true
                    }
                ]
            }
        };

        const final = await completeWithAutoValidationLoop({
            initialResponse,
            autoFixResult: { autoFixApplied: true },
            autoValidationContext: {
                isRevalidation: true,
                attempt: 2
            },
            deploymentPackage: {},
            runValidation: async () => {
                validationCalls += 1;
                return {};
            }
        });

        assert.strictEqual(validationCalls, 0);
        assert.strictEqual(final, initialResponse);
        assert.strictEqual(final.autoValidationReport, undefined);
    });

    await runTest(
        'Revalidation package forces VALIDATE and never DEPLOY',
        () => {
            const pkg = buildRevalidationPackage(
                {
                    selectedMetadata: [{ metadataType: 'ApexClass', metadataName: 'Old' }],
                    deploymentMode: 'DEPLOY',
                    executeDeployment: true,
                    repoUrl: 'https://example.com/repo.git'
                },
                {
                    generatedDeploymentPackage: {
                        metadata: [
                            {
                                metadataType: 'ExternalCredential',
                                metadataName: 'Weather'
                            }
                        ]
                    }
                }
            );

            assert.strictEqual(pkg.deploymentMode, 'VALIDATE');
            assert.strictEqual(pkg.executeDeployment, false);
            assert.strictEqual(pkg.repoUrl, 'https://example.com/repo.git');
            assert.strictEqual(pkg.selectedMetadata.length, 1);
            assert.strictEqual(pkg.selectedMetadata[0].metadataName, 'Weather');
        }
    );

    await runTest('deriveValidationStatus and report helpers', () => {
        assert.strictEqual(
            deriveValidationStatus({
                checkOnlyDeployment: { success: true, status: 'SUCCESS' }
            }),
            'SUCCESS'
        );
        assert.strictEqual(
            deriveValidationStatus({
                checkOnlyDeployment: { success: false, status: 'FAILED' }
            }),
            'FAILED'
        );
        assert.strictEqual(
            countAutoFixesApplied({
                fixes: [
                    {
                        fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                        successful: true
                    },
                    {
                        fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                        successful: false
                    },
                    { fixType: 'REGENERATE_PACKAGE', successful: true }
                ]
            }),
            2
        );

        const report = buildAutoValidationReport({
            attempts: 2,
            autoValidationExecuted: true,
            initialStatus: 'FAILED',
            finalResponse: {
                checkOnlyDeployment: { success: false },
                failureClassification: {
                    failures: [{ key: 'X:Y' }]
                }
            },
            autoFixesApplied: 1,
            revalidated: true
        });

        assert.strictEqual(report.finalStatus, 'FAILED');
        assert.strictEqual(report.remainingFailures.length, 1);
    });
}

main();
