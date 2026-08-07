const assert = require('assert');

const {
    generateAiResolutionReport,
    buildDeterministicExplanation,
    collectKnownItems,
    DEFAULT_DISCLAIMER
} = require('./aiDeploymentAdvisor.service');

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

function formulaContext() {
    return {
        failureClassification: {
            overallStatus: 'CLASSIFIED',
            failures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    category: 'MANUAL_ACTION',
                    reason: 'Formula type conversion is incompatible.'
                }
            ]
        },
        resolutionReport: {
            resolutions: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    resolutionType: 'MANUAL_METADATA_CHANGE',
                    severity: 'HIGH',
                    title: 'Formula incompatibility',
                    recommendation: 'Recreate the field manually.'
                }
            ]
        },
        autoFixReport: { autoFixAvailable: false, autoFixApplied: false, fixes: [] },
        autoValidationReport: {
            attempts: 1,
            autoValidationExecuted: false,
            revalidated: false
        }
    };
}

function personAccountContext() {
    return {
        failureClassification: {
            failures: [
                {
                    metadataType: 'RecordType',
                    metadataName: 'PersonAccount.PersonAccount',
                    category: 'MANUAL_ACTION',
                    reason: 'Person Account RecordType is unavailable.'
                }
            ]
        },
        resolutionReport: {
            resolutions: [
                {
                    metadataType: 'RecordType',
                    metadataName: 'PersonAccount.PersonAccount',
                    resolutionType: 'ENABLE_FEATURE',
                    severity: 'HIGH'
                }
            ]
        },
        autoFixReport: { fixes: [] }
    };
}

function missingDependencyContext() {
    return {
        failureClassification: {
            failures: [
                {
                    metadataType: 'ExternalCredential',
                    metadataName: 'Weather',
                    category: 'MANUAL_ACTION',
                    reason: 'Required dependency not included in the package.'
                }
            ]
        },
        resolutionReport: {
            resolutions: [
                {
                    metadataType: 'ExternalCredential',
                    metadataName: 'Weather',
                    resolutionType: 'DEPENDENCY',
                    severity: 'HIGH'
                }
            ]
        },
        autoFixReport: { autoFixApplied: false, fixes: [] }
    };
}

function autoFixedDependencyContext() {
    return {
        failureClassification: { failures: [] },
        resolutionReport: { resolutions: [] },
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
                }
            ]
        },
        autoValidationReport: {
            attempts: 2,
            autoValidationExecuted: true,
            finalStatus: 'SUCCESS',
            revalidated: true
        }
    };
}

async function main() {
    await runTest('AI disabled', async () => {
        const report = await generateAiResolutionReport(formulaContext(), {
            enabled: false,
            provider: 'openai',
            generateText: async () => {
                throw new Error('should not call provider when disabled');
            }
        });

        assert.strictEqual(report.available, false);
        assert.strictEqual(report.generated, false);
        assert.strictEqual(report.explanations.length, 0);
        assert.ok(report.disclaimer.includes('advisory only'));
    });

    await runTest('GPT provider', async () => {
        let calledProvider = null;

        const report = await generateAiResolutionReport(formulaContext(), {
            enabled: true,
            provider: 'openai',
            generateText: async (prompt, options) => {
                calledProvider = options.provider;
                assert.ok(prompt.includes('Structured context'));
                assert.ok(!prompt.includes('package.xml'));
                assert.ok(!prompt.includes('Apex source'));
                return {
                    provider: 'openai',
                    text: JSON.stringify({
                        summary: 'Formula field cannot be converted.',
                        explanations: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Account.Score__c',
                                severity: 'HIGH',
                                title: 'Formula incompatibility',
                                why: 'Salesforce does not allow conversion from Formula fields to stored field types.',
                                impact:
                                    'Deployment cannot continue until the field types are compatible.',
                                recommendedAction:
                                    'Create a new field or migrate data before replacing the Formula field.',
                                bestPractice:
                                    'Perform field type migrations in multiple deployment stages.',
                                confidence: 'HIGH'
                            }
                        ]
                    })
                };
            }
        });

        assert.strictEqual(calledProvider, 'openai');
        assert.strictEqual(report.available, true);
        assert.strictEqual(report.generated, true);
        assert.strictEqual(report.provider, 'openai');
        assert.strictEqual(report.explanations.length, 1);
        assert.strictEqual(
            report.explanations[0].metadataName,
            'Account.Score__c'
        );
    });

    await runTest('Gemini provider', async () => {
        let calledProvider = null;

        const report = await generateAiResolutionReport(personAccountContext(), {
            enabled: true,
            provider: 'gemini',
            generateText: async (_prompt, options) => {
                calledProvider = options.provider;
                return {
                    provider: 'gemini',
                    text: JSON.stringify({
                        summary: 'Person Accounts are required.',
                        explanations: [
                            {
                                metadataType: 'RecordType',
                                metadataName: 'PersonAccount.PersonAccount',
                                severity: 'HIGH',
                                title: 'Person Account feature dependency',
                                why: 'The destination org does not contain the required Person Account RecordType.',
                                impact:
                                    'PermissionSet references cannot be validated.',
                                recommendedAction:
                                    'Enable Person Accounts or deploy into an org where the feature is available.',
                                bestPractice:
                                    'Validate platform feature dependencies before deployment.',
                                confidence: 'HIGH'
                            }
                        ]
                    })
                };
            }
        });

        assert.strictEqual(calledProvider, 'gemini');
        assert.strictEqual(report.provider, 'gemini');
        assert.strictEqual(report.explanations[0].title.includes('Person'), true);
    });

    await runTest('Formula explanation', async () => {
        const explanation = buildDeterministicExplanation(
            collectKnownItems(formulaContext())[0]
        );

        assert.ok(
            explanation.why.includes(
                'does not allow conversion from Formula fields'
            )
        );
        assert.ok(explanation.impact.includes('cannot continue'));
        assert.ok(explanation.recommendedAction.includes('Create a new field'));
        assert.ok(
            explanation.bestPractice.includes('multiple deployment stages')
        );
    });

    await runTest('PersonAccount explanation', async () => {
        const explanation = buildDeterministicExplanation(
            collectKnownItems(personAccountContext())[0]
        );

        assert.ok(explanation.why.includes('Person Account RecordType'));
        assert.ok(
            explanation.impact.includes('PermissionSet references cannot be validated')
        );
        assert.ok(explanation.recommendedAction.includes('Enable Person Accounts'));
        assert.ok(
            explanation.bestPractice.includes('platform feature dependencies')
        );
    });

    await runTest('Missing dependency explanation', async () => {
        const explanation = buildDeterministicExplanation(
            collectKnownItems(missingDependencyContext())[0]
        );

        assert.ok(
            explanation.why.includes('not included in the deployment package')
        );
        assert.ok(explanation.impact.includes('incomplete'));
        assert.ok(explanation.bestPractice.includes('dependency discovery'));
    });

    await runTest('Auto-fixed dependency explanation', async () => {
        const report = await generateAiResolutionReport(
            autoFixedDependencyContext(),
            {
                enabled: true,
                provider: 'openai',
                generateText: async () => ({
                    provider: 'openai',
                    text: JSON.stringify({
                        summary: 'Dependency auto-fixed.',
                        explanations: [
                            {
                                metadataType: 'ExternalCredential',
                                metadataName: 'Weather',
                                severity: 'INFO',
                                title: 'Auto-fixed dependency',
                                why: 'Backend automatically resolved the dependency.',
                                impact: 'Package was incomplete before auto-fix.',
                                recommendedAction:
                                    'Dependency was automatically added during validation.',
                                bestPractice:
                                    'Use dependency discovery before deployment.',
                                confidence: 'HIGH'
                            }
                        ]
                    })
                })
            }
        );

        assert.strictEqual(report.explanations.length, 1);
        assert.strictEqual(report.explanations[0].metadataName, 'Weather');
        assert.ok(
            report.explanations[0].recommendedAction.includes(
                'automatically added'
            )
        );
    });

    await runTest('Empty failure list', async () => {
        const report = await generateAiResolutionReport(
            {
                failureClassification: { failures: [] },
                resolutionReport: { resolutions: [] },
                autoFixReport: { fixes: [] }
            },
            {
                enabled: true,
                provider: 'gemini',
                generateText: async () => {
                    throw new Error('should not call provider for empty list');
                }
            }
        );

        assert.strictEqual(report.available, true);
        assert.strictEqual(report.generated, true);
        assert.deepStrictEqual(report.explanations, []);
        assert.ok(report.summary.includes('No deployment failures'));
        assert.strictEqual(report.disclaimer, DEFAULT_DISCLAIMER);
    });

    await runTest('Rejects invented metadata from AI response', async () => {
        const report = await generateAiResolutionReport(formulaContext(), {
            enabled: true,
            provider: 'openai',
            generateText: async () => ({
                provider: 'openai',
                text: JSON.stringify({
                    summary: 'Invented component should be dropped.',
                    explanations: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'InventedClass',
                            severity: 'HIGH',
                            title: 'Invented',
                            why: 'fake',
                            impact: 'fake',
                            recommendedAction: 'skip validation',
                            bestPractice: 'none',
                            confidence: 'HIGH'
                        }
                    ]
                })
            })
        });

        // Invented entry rejected → deterministic fallback for known items.
        assert.strictEqual(report.generated, true);
        assert.ok(
            report.explanations.every(
                (entry) => entry.metadataName === 'Account.Score__c'
            )
        );
        assert.ok(
            !report.explanations.some(
                (entry) => entry.metadataName === 'InventedClass'
            )
        );
    });
}

main();
