const assert = require('assert');

const { buildAiContext } = require('./aiContextBuilder.service');
const {
    generateSemanticResponse,
    resolveAdapterConfig,
    ADVISOR_STATUS,
    LLM_PROVIDERS,
    listProviderIds,
    validateSemanticResponse
} = require('./llmAdapter.service');
const { ProviderError } = require('./llmProviders/providerUtils');
const mockProvider = require('./llmProviders/mock.provider');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function buildSampleContext() {
    const { context, validation } = buildAiContext({
        plannerDecisions: [
            {
                metadataType: 'CustomField',
                metadataName: 'Account.Status__c',
                choice: 'SKIP',
                canSkip: false,
                decision: 'APPLY',
                reason: 'Analyzer: authorization DENIED; Deploy required.',
                confidence: 'HIGH',
                destinationState: 'EXISTS',
                useAnalyzer: true,
                fallbackUsed: false,
                analysisLevel: 'EXISTENCE',
                authorization: {
                    authorized: false,
                    availability: 'DENIED',
                    reasons: ['Authorization DENIED: CONTRACT capability failed.'],
                    trace: {
                        evaluated: [
                            {
                                capability: 'CONTRACT',
                                role: 'ACTIVE',
                                status: 'FAIL',
                                trusted: true,
                                contributedToCanSkip: false
                            }
                        ]
                    }
                }
            }
        ],
        plannerCompatibility: {
            plannerCompatibility: {
                results: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Status__c',
                        canSkip: false,
                        analysisLevel: 'EXISTENCE',
                        graphSafe: true,
                        capabilities: {
                            EXISTENCE: {
                                status: 'PASS',
                                evidence: {
                                    destinationState: 'EXISTS',
                                    existsInDestination: true
                                }
                            },
                            GRAPH: {
                                status: 'PASS',
                                evidence: { graphSafe: true }
                            },
                            CONTRACT: {
                                status: 'FAIL',
                                reason: 'type mismatch',
                                evidence: {
                                    rulesChecked: ['FIELD_TYPE'],
                                    mismatches: [
                                        {
                                            ruleId: 'FIELD_TYPE',
                                            field: 'type',
                                            message: 'type mismatch'
                                        }
                                    ]
                                }
                            }
                        }
                    }
                ]
            }
        },
        generatedDeploymentPackage: {
            summary: {
                metadataCount: 1,
                dependencyCount: 0,
                testClassCount: 0,
                totalComponents: 1
            },
            metadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Status__c'
                }
            ]
        },
        request: { validationId: 'val-10c', mode: 'validate' },
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    assert.strictEqual(validation.valid, true, validation.errors.join('; '));
    return context;
}

async function main() {
    await runTest('provider registry lists MOCK OPENAI GEMINI CLAUDE', () => {
        assert.deepStrictEqual(listProviderIds(), [
            'CLAUDE',
            'GEMINI',
            'MOCK',
            'OPENAI'
        ]);
    });

    await runTest('AI_ENABLED=false returns DISABLED without provider call', async () => {
        const previous = process.env.AI_ENABLED;
        process.env.AI_ENABLED = 'false';

        try {
            const context = buildSampleContext();
            let mockCalled = false;
            const original = mockProvider.generate;
            mockProvider.generate = async () => {
                mockCalled = true;
                return original({ context });
            };

            const result = await generateSemanticResponse(context);

            assert.strictEqual(result.advisorStatus, ADVISOR_STATUS.DISABLED);
            assert.strictEqual(result.semanticResponse, null);
            assert.strictEqual(result.diagnostics.errorCode, ADVISOR_STATUS.DISABLED);
            assert.strictEqual(mockCalled, false);
            assert.ok(!('plannerDecision' in result));

            mockProvider.generate = original;
        } finally {
            if (previous === undefined) {
                delete process.env.AI_ENABLED;
            } else {
                process.env.AI_ENABLED = previous;
            }
        }
    });

    await runTest('options.enabled=false overrides env and returns DISABLED', async () => {
        const result = await generateSemanticResponse(buildSampleContext(), {
            enabled: false,
            provider: LLM_PROVIDERS.MOCK
        });

        assert.strictEqual(result.advisorStatus, ADVISOR_STATUS.DISABLED);
        assert.strictEqual(result.semanticResponse, null);
    });

    await runTest('MOCK provider returns OK structured semantic response', async () => {
        const result = await generateSemanticResponse(buildSampleContext(), {
            enabled: true,
            provider: LLM_PROVIDERS.MOCK
        });

        assert.strictEqual(result.advisorStatus, ADVISOR_STATUS.OK);
        assert.ok(result.semanticResponse);
        assert.strictEqual(result.diagnostics.provider, 'MOCK');
        assert.ok(typeof result.diagnostics.latencyMs === 'number');
        assert.strictEqual(result.diagnostics.tokenUsage, null);

        const validation = validateSemanticResponse(result.semanticResponse);
        assert.strictEqual(validation.valid, true, validation.errors.join('; '));
        assert.ok(
            result.semanticResponse.itemExplanations.length >= 1
        );
        assert.ok(
            result.semanticResponse.riskSummary.includes('CONTRACT_FAIL')
        );
    });

    await runTest('invalid context returns INVALID_RESPONSE without throw', async () => {
        const result = await generateSemanticResponse(
            { schemaVersion: 'bad' },
            { enabled: true, provider: LLM_PROVIDERS.MOCK }
        );

        assert.strictEqual(
            result.advisorStatus,
            ADVISOR_STATUS.INVALID_RESPONSE
        );
        assert.strictEqual(result.semanticResponse, null);
        assert.ok(/Invalid AI context/i.test(result.diagnostics.errorMessage));
    });

    await runTest('unknown provider returns UNAVAILABLE', async () => {
        const result = await generateSemanticResponse(buildSampleContext(), {
            enabled: true,
            provider: 'NOT_A_PROVIDER'
        });

        assert.strictEqual(result.advisorStatus, ADVISOR_STATUS.UNAVAILABLE);
        assert.strictEqual(result.semanticResponse, null);
    });

    await runTest('provider timeout maps to TIMEOUT status', async () => {
        const original = mockProvider.generate;
        mockProvider.generate = async () => {
            throw new ProviderError(ADVISOR_STATUS.TIMEOUT, 'timed out');
        };

        try {
            const result = await generateSemanticResponse(buildSampleContext(), {
                enabled: true,
                provider: LLM_PROVIDERS.MOCK
            });

            assert.strictEqual(result.advisorStatus, ADVISOR_STATUS.TIMEOUT);
            assert.strictEqual(result.semanticResponse, null);
            assert.strictEqual(
                result.diagnostics.errorCode,
                ADVISOR_STATUS.TIMEOUT
            );
        } finally {
            mockProvider.generate = original;
        }
    });

    await runTest('provider auth failure maps to AUTH_FAILURE', async () => {
        const original = mockProvider.generate;
        mockProvider.generate = async () => {
            throw new ProviderError(
                ADVISOR_STATUS.AUTH_FAILURE,
                'missing key'
            );
        };

        try {
            const result = await generateSemanticResponse(buildSampleContext(), {
                enabled: true,
                provider: LLM_PROVIDERS.MOCK
            });

            assert.strictEqual(
                result.advisorStatus,
                ADVISOR_STATUS.AUTH_FAILURE
            );
            assert.strictEqual(result.semanticResponse, null);
        } finally {
            mockProvider.generate = original;
        }
    });

    await runTest('invalid provider JSON maps to INVALID_RESPONSE', async () => {
        const original = mockProvider.generate;
        mockProvider.generate = async () => ({
            text: 'not-json',
            tokenUsage: null,
            model: 'mock'
        });

        try {
            const result = await generateSemanticResponse(buildSampleContext(), {
                enabled: true,
                provider: LLM_PROVIDERS.MOCK
            });

            assert.strictEqual(
                result.advisorStatus,
                ADVISOR_STATUS.INVALID_RESPONSE
            );
            assert.strictEqual(result.semanticResponse, null);
        } finally {
            mockProvider.generate = original;
        }
    });

    await runTest('resolveAdapterConfig defaults AI off and MOCK provider', () => {
        const previousEnabled = process.env.AI_ENABLED;
        const previousProvider = process.env.AI_PROVIDER;
        delete process.env.AI_ENABLED;
        delete process.env.AI_PROVIDER;

        try {
            const config = resolveAdapterConfig();
            assert.strictEqual(config.enabled, false);
            assert.strictEqual(config.provider, LLM_PROVIDERS.MOCK);
        } finally {
            if (previousEnabled !== undefined) {
                process.env.AI_ENABLED = previousEnabled;
            }
            if (previousProvider !== undefined) {
                process.env.AI_PROVIDER = previousProvider;
            }
        }
    });

    await runTest('adapter result never includes planner mutation fields', async () => {
        const result = await generateSemanticResponse(buildSampleContext(), {
            enabled: true,
            provider: LLM_PROVIDERS.MOCK
        });

        assert.strictEqual(result.canSkip, undefined);
        assert.strictEqual(result.authorized, undefined);
        assert.strictEqual(result.TRUST_POLICY, undefined);
        assert.deepStrictEqual(Object.keys(result).sort(), [
            'advisorStatus',
            'diagnostics',
            'semanticResponse'
        ]);
    });

    if (!process.exitCode) {
        console.log('Phase 10C regression: PASS');
    }
}

main();
