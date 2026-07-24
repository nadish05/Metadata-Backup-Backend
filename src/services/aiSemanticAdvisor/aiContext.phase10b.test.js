const assert = require('assert');

const {
    buildAiContext,
    validateAiContext,
    stableStringify,
    AI_CONTEXT_SCHEMA_VERSION,
    AI_CONTEXT_VERSION,
    DEFAULT_CONSTRAINTS,
    RISK_INDICATORS
} = require('./aiContextBuilder.service');
const {
    FORBIDDEN_PAYLOAD_KEYS
} = require('./aiContext.schema');

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

function sampleDecision(overrides = {}) {
    return {
        metadataType: 'CustomField',
        metadataName: 'Account.Status__c',
        choice: 'SKIP',
        editable: true,
        canSkip: false,
        allowOverride: true,
        decision: 'APPLY',
        reason: 'Analyzer: authorization DENIED; Deploy required (Skip not authorized).',
        analysisLevel: 'EXISTENCE',
        confidence: 'HIGH',
        destinationState: 'EXISTS',
        useAnalyzer: true,
        fallbackUsed: false,
        decisionPath: 'ANALYZER',
        found: true,
        authorization: {
            canSkip: false,
            authorized: false,
            availability: 'DENIED',
            reasons: [
                'EXISTENCE policy: destination EXISTS; Skip capability granted.',
                'GRAPH policy: status PASS; capability granted.',
                'CONTRACT policy: authorization denied (status=FAIL); type mismatch',
                'Authorization DENIED: CONTRACT capability failed.'
            ],
            trace: {
                graphTrusted: true,
                contractTrusted: true,
                evaluated: [
                    {
                        capability: 'EXISTENCE',
                        role: 'ACTIVE',
                        status: 'PASS',
                        trusted: true,
                        contributedToCanSkip: true
                    },
                    {
                        capability: 'GRAPH',
                        role: 'ACTIVE',
                        status: 'PASS',
                        trusted: true,
                        contributedToCanSkip: true
                    },
                    {
                        capability: 'CONTRACT',
                        role: 'ACTIVE',
                        status: 'FAIL',
                        trusted: true,
                        contributedToCanSkip: false
                    }
                ]
            }
        },
        ...overrides
    };
}

function sampleCompatibility() {
    return {
        plannerCompatibility: {
            results: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Status__c',
                    existsInDestination: true,
                    graphSafe: true,
                    graphReasons: [],
                    canSkip: true,
                    analysisLevel: 'EXISTENCE',
                    reason: 'Exists in destination',
                    capabilities: {
                        EXISTENCE: {
                            status: 'PASS',
                            reason: 'exists',
                            evidence: {
                                destinationState: 'EXISTS',
                                existsInDestination: true
                            }
                        },
                        GRAPH: {
                            status: 'PASS',
                            reason: 'safe',
                            evidence: {
                                graphSafe: true,
                                blockingDependsOn: [],
                                dependsOnChecked: ['Account'],
                                unresolvedCount: 0
                            }
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
                                        message: 'type mismatch',
                                        sourceValue: 'Text',
                                        destinationValue: 'Number'
                                    }
                                ],
                                sourceSummary: { type: 'string', length: 80 },
                                destinationSummary: {
                                    type: 'double',
                                    precision: 18
                                }
                            }
                        },
                        SEMANTIC: {
                            status: 'NOT_EVALUATED',
                            reason: 'SEMANTIC capability is not evaluated yet.',
                            evidence: {}
                        }
                    }
                },
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Invoice__c',
                    existsInDestination: true,
                    graphSafe: true,
                    canSkip: true,
                    analysisLevel: 'EXISTENCE',
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
                            evidence: { graphSafe: true, unresolvedCount: 0 }
                        },
                        CONTRACT: {
                            status: 'NOT_EVALUATED',
                            evidence: {}
                        }
                    }
                }
            ],
            summary: { analyzed: 2, canSkip: 2 }
        }
    };
}

function samplePackage() {
    return {
        metadata: [
            {
                metadataType: 'CustomField',
                metadataName: 'Account.Status__c',
                filePath: '/repo/force-app/main/default/objects/Account/fields/Status__c.field-meta.xml'
            }
        ],
        dependencies: [
            { type: 'CustomObject', name: 'Account', action: 'DEPLOY' }
        ],
        testClasses: [{ name: 'AccountTest' }],
        summary: {
            metadataCount: 1,
            dependencyCount: 1,
            testClassCount: 1,
            totalComponents: 2
        }
    };
}

runTest('builds versioned context with required sections', () => {
    const { context, validation } = buildAiContext({
        plannerDecisions: [sampleDecision()],
        plannerCompatibility: sampleCompatibility(),
        generatedDeploymentPackage: samplePackage(),
        request: { validationId: 'val-1', mode: 'validate' },
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    assert.strictEqual(validation.valid, true, validation.errors.join('; '));
    assert.strictEqual(context.schemaVersion, AI_CONTEXT_SCHEMA_VERSION);
    assert.strictEqual(
        context.advisorMetadata.contextVersion,
        AI_CONTEXT_VERSION
    );
    assert.deepStrictEqual(context.constraints, { ...DEFAULT_CONSTRAINTS });
    assert.strictEqual(context.advisorMetadata.aiGenerated, false);
    assert.ok(context.advisorMetadata.contextSize > 0);
    assert.strictEqual(context.items.length, 2);
});

runTest('context build is deterministic for identical inputs', () => {
    const input = {
        plannerDecisions: [sampleDecision()],
        plannerCompatibility: sampleCompatibility(),
        generatedDeploymentPackage: samplePackage(),
        request: { validationId: 'val-1', mode: 'validate' },
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    };

    const a = buildAiContext(input);
    const b = buildAiContext(input);

    assert.strictEqual(a.validation.valid, true);
    assert.strictEqual(
        stableStringify(a.context),
        stableStringify(b.context)
    );
});

runTest('items are sorted and contain planner facts only', () => {
    const { context, validation } = buildAiContext({
        plannerDecisions: [sampleDecision()],
        plannerCompatibility: sampleCompatibility(),
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    assert.strictEqual(validation.valid, true);
    assert.strictEqual(context.items[0].metadataType, 'CustomField');
    assert.strictEqual(context.items[1].metadataType, 'CustomObject');

    const field = context.items[0];
    assert.strictEqual(field.planner.availability, 'DENIED');
    assert.strictEqual(field.capabilities.CONTRACT.status, 'FAIL');
    assert.strictEqual(field.contract.mismatchCount, 1);
    assert.strictEqual(field.graph.graphSafe, true);
    assert.ok(!('filePath' in field));
    assert.ok(!('xml' in field));
    assert.ok(!('sourceXml' in field));
});

runTest('summary includes risk indicators and counts', () => {
    const { context, validation } = buildAiContext({
        plannerDecisions: [sampleDecision()],
        plannerCompatibility: sampleCompatibility(),
        generatedDeploymentPackage: samplePackage(),
        deploymentSummary: {
            deployCount: 1,
            skipCount: 0,
            ignoredCount: 0
        },
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    assert.strictEqual(validation.valid, true);
    assert.ok(
        context.summary.riskIndicators.includes(RISK_INDICATORS.CONTRACT_FAIL)
    );
    assert.ok(
        context.summary.riskIndicators.includes(
            RISK_INDICATORS.AUTHORIZATION_DENIED
        )
    );
    assert.strictEqual(context.summary.capabilities.contractFail, 1);
    assert.strictEqual(context.summary.authorization.denied, 1);
    assert.strictEqual(context.summary.package.totalComponents, 2);
    assert.strictEqual(context.summary.planner.deployCount, 1);
});

runTest('package section omits filePath and credentials', () => {
    const { context, validation } = buildAiContext({
        plannerDecisions: [],
        plannerCompatibility: sampleCompatibility(),
        generatedDeploymentPackage: {
            ...samplePackage(),
            clientSecret: 'should-never-appear',
            accessToken: 'tok_should_never_appear_abcdefghijklmnopqrstuvwxyz'
        },
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    assert.strictEqual(validation.valid, true);
    const serialized = stableStringify(context);
    assert.ok(!serialized.includes('filePath'));
    assert.ok(!serialized.includes('clientSecret'));
    assert.ok(!serialized.includes('should-never-appear'));
    assert.ok(!serialized.includes('/repo/'));
    assert.deepStrictEqual(context.package.metadataTypes, [
        'CustomField',
        'CustomObject'
    ]);
});

runTest('respects maxItems and records truncation', () => {
    const { context, validation } = buildAiContext({
        plannerCompatibility: sampleCompatibility(),
        options: {
            generatedAt: '2026-07-24T00:00:00.000Z',
            maxItems: 1
        }
    });

    assert.strictEqual(validation.valid, true);
    assert.strictEqual(context.items.length, 1);
    assert.strictEqual(context.advisorMetadata.truncated, true);
    assert.strictEqual(context.advisorMetadata.totalCandidates, 2);
    assert.strictEqual(context.summary.planner.truncated, true);
});

runTest('validateAiContext rejects missing sections', () => {
    const result = validateAiContext({ schemaVersion: AI_CONTEXT_SCHEMA_VERSION });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((error) => /Missing required section/.test(error)));
});

runTest('validateAiContext rejects constraints that allow decision changes', () => {
    const { context } = buildAiContext({
        plannerCompatibility: sampleCompatibility(),
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    context.constraints.aiMustNotChangeDecisions = false;
    const result = validateAiContext(context);
    assert.strictEqual(result.valid, false);
});

runTest('forbidden payload keys are listed for schema protection', () => {
    assert.ok(FORBIDDEN_PAYLOAD_KEYS.includes('sourceXml'));
    assert.ok(FORBIDDEN_PAYLOAD_KEYS.includes('accessToken'));
    assert.ok(FORBIDDEN_PAYLOAD_KEYS.includes('filePath'));
});

runTest('no AI narrative fields are produced', () => {
    const { context, validation } = buildAiContext({
        plannerDecisions: [sampleDecision()],
        plannerCompatibility: sampleCompatibility(),
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    assert.strictEqual(validation.valid, true);
    assert.strictEqual(context.executiveSummary, undefined);
    assert.strictEqual(context.recommendations, undefined);
    assert.strictEqual(context.advisorMetadata.aiGenerated, false);
});

if (!process.exitCode) {
    console.log('Phase 10B regression: PASS');
}
