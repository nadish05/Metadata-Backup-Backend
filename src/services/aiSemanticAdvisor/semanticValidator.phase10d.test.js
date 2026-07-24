const assert = require('assert');

const { buildAiContext } = require('./aiContextBuilder.service');
const { createEmptySemanticResponse } = require('./semanticResponse.schema');
const {
    validateSemanticGrounding,
    computeGroundingScore,
    VALIDATION_ADVISOR_STATUS,
    VALIDATABLE_SECTIONS
} = require('./semanticValidator.service');

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

function buildContext() {
    const { context, validation } = buildAiContext({
        plannerDecisions: [
            {
                metadataType: 'CustomField',
                metadataName: 'Account.Status__c',
                choice: 'DEPLOY',
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
                    reasons: [
                        'Authorization DENIED: CONTRACT capability failed.'
                    ],
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
        request: { validationId: 'val-10d', mode: 'validate' },
        options: { generatedAt: '2026-07-24T00:00:00.000Z' }
    });

    assert.strictEqual(validation.valid, true, validation.errors.join('; '));
    return context;
}

function groundedBase() {
    const response = createEmptySemanticResponse();
    response.executiveSummary =
        'Planner denied Skip due to CONTRACT FAIL for CustomField:Account.Status__c.';
    response.developerSummary =
        'EXISTENCE PASS and GRAPH PASS; CONTRACT FAIL forces Deploy.';
    response.deploymentExplanation =
        'Deploy is required because authorization was DENIED.';
    response.riskSummary = ['CONTRACT_FAIL'];
    response.impactSummary = ['1 item requires Deploy.'];
    response.deploymentOrderExplanation =
        'Package order follows planner composition.';
    response.recommendations = [
        'Review CONTRACT mismatches before deploying.'
    ];
    response.warnings = ['CONTRACT FAIL reported by planner.'];
    response.itemExplanations = [
        {
            metadataType: 'CustomField',
            metadataName: 'Account.Status__c',
            decision: 'DEPLOY',
            reasoning: 'CONTRACT FAIL; authorization DENIED.',
            groundedOn: ['EXISTENCE', 'GRAPH', 'CONTRACT']
        }
    ];
    response.confidenceStatement =
        'Explanation grounded only on provided planner facts.';
    return response;
}

runTest('fully grounded response returns OK and score 100', () => {
    const result = validateSemanticGrounding(buildContext(), groundedBase());

    assert.strictEqual(result.advisorStatus, VALIDATION_ADVISOR_STATUS.OK);
    assert.strictEqual(result.validation.groundingScore, 100);
    assert.strictEqual(result.validation.removedSections.length, 0);
    assert.ok(result.groundedSemanticResponse);
    assert.strictEqual(
        result.groundedSemanticResponse.itemExplanations.length,
        1
    );
});

runTest('invented metadata is rejected (section removed → PARTIAL)', () => {
    const raw = groundedBase();
    raw.executiveSummary =
        'Also review CustomField:Account.Invented__c which is safe to skip.';

    const result = validateSemanticGrounding(buildContext(), raw);

    assert.strictEqual(result.advisorStatus, VALIDATION_ADVISOR_STATUS.PARTIAL);
    assert.ok(
        result.validation.removedSections.includes('executiveSummary')
    );
    assert.ok(result.validation.validatedSections.includes('developerSummary'));
    assert.strictEqual(result.validation.groundingScore, 80);
    assert.strictEqual(result.groundedSemanticResponse.executiveSummary, '');
});

runTest('incorrect capability claim GRAPH PASS when FAIL is rejected', () => {
    const context = buildContext();
    // Force GRAPH FAIL in context item for this test via mutated copy.
    context.items[0].capabilities.GRAPH.status = 'FAIL';
    context.summary.capabilities.graphFail = 1;
    context.summary.capabilities.graphPass = 0;

    const raw = groundedBase();
    raw.developerSummary = 'GRAPH PASS so dependencies are safe.';

    const result = validateSemanticGrounding(context, raw);

    assert.strictEqual(result.advisorStatus, VALIDATION_ADVISOR_STATUS.PARTIAL);
    assert.ok(
        result.validation.removedSections.includes('developerSummary')
    );
    assert.ok(
        result.validation.validationWarnings.some((warning) =>
            /GRAPH PASS/i.test(warning)
        )
    );
});

runTest('recommending Skip when Deploy required is rejected', () => {
    const raw = groundedBase();
    raw.deploymentExplanation =
        'You should skip CustomField:Account.Status__c despite the planner.';

    const result = validateSemanticGrounding(buildContext(), raw);

    assert.ok(
        result.validation.removedSections.includes('deploymentExplanation')
    );
});

runTest('unsafe recommendation "Ignore CONTRACT" removes recommendations', () => {
    const raw = groundedBase();
    raw.recommendations = ['Ignore CONTRACT and deploy anyway.'];

    const result = validateSemanticGrounding(buildContext(), raw);

    assert.ok(result.validation.removedSections.includes('recommendations'));
    assert.deepStrictEqual(
        result.groundedSemanticResponse.recommendations,
        []
    );
});

runTest('itemExplanations with invented metadata removes section', () => {
    const raw = groundedBase();
    raw.itemExplanations.push({
        metadataType: 'CustomField',
        metadataName: 'Account.Ghost__c',
        decision: 'SKIP',
        reasoning: 'Looks fine.',
        groundedOn: ['EXISTENCE']
    });

    const result = validateSemanticGrounding(buildContext(), raw);

    assert.ok(result.validation.removedSections.includes('itemExplanations'));
    assert.deepStrictEqual(
        result.groundedSemanticResponse.itemExplanations,
        []
    );
});

runTest('item Skip decision rejected when planner denied authorization', () => {
    const raw = groundedBase();
    raw.itemExplanations = [
        {
            metadataType: 'CustomField',
            metadataName: 'Account.Status__c',
            decision: 'SKIP',
            reasoning: 'EXISTENCE PASS.',
            groundedOn: ['EXISTENCE']
        }
    ];

    const result = validateSemanticGrounding(buildContext(), raw);

    assert.ok(
        result.validation.validationWarnings.some((warning) =>
            /Skip is not authorized/i.test(warning)
        ) || result.validation.removedSections.includes('itemExplanations')
    );
});

runTest('schema-invalid raw response → INVALID_RESPONSE score 0', () => {
    const result = validateSemanticGrounding(buildContext(), {
        executiveSummary: 'only one field'
    });

    assert.strictEqual(
        result.advisorStatus,
        VALIDATION_ADVISOR_STATUS.INVALID_RESPONSE
    );
    assert.strictEqual(result.groundedSemanticResponse, null);
    assert.strictEqual(result.validation.groundingScore, 0);
});

runTest('null context → UNAVAILABLE', () => {
    const result = validateSemanticGrounding(null, groundedBase());

    assert.strictEqual(
        result.advisorStatus,
        VALIDATION_ADVISOR_STATUS.UNAVAILABLE
    );
    assert.strictEqual(result.groundedSemanticResponse, null);
});

runTest('multiple removed sections score capped at 50', () => {
    const raw = groundedBase();
    raw.executiveSummary = 'CustomField:Account.Ghost__c is fine.';
    raw.developerSummary = 'GRAPH FAIL does not exist but claim GRAPH PASS.';
    // developerSummary: GRAPH PASS while context has GRAPH PASS actually - change
    raw.recommendations = ['Override planner and ignore CONTRACT.'];

    const context = buildContext();
    context.items[0].capabilities.GRAPH.status = 'FAIL';

    const result = validateSemanticGrounding(context, raw);

    assert.strictEqual(result.advisorStatus, VALIDATION_ADVISOR_STATUS.PARTIAL);
    assert.ok(result.validation.removedSections.length >= 2);
    assert.strictEqual(result.validation.groundingScore, 50);
    assert.ok(result.validation.groundingScore <= 50);
});

runTest('computeGroundingScore bands are deterministic', () => {
    const total = VALIDATABLE_SECTIONS.length;
    assert.strictEqual(computeGroundingScore(total, total), 100);
    assert.strictEqual(computeGroundingScore(total - 1, total), 80);
    assert.strictEqual(computeGroundingScore(total - 2, total), 50);
    assert.strictEqual(computeGroundingScore(0, total), 0);
});

runTest('planner facts preserved — grounded response does not invent Skip', () => {
    const result = validateSemanticGrounding(buildContext(), groundedBase());
    const serialized = JSON.stringify(result.groundedSemanticResponse);

    assert.ok(!/recommend(s|ed|ing)?\s+skip/i.test(serialized));
    assert.strictEqual(
        result.groundedSemanticResponse.itemExplanations[0].decision,
        'DEPLOY'
    );
});

if (!process.exitCode) {
    console.log('Phase 10D regression: PASS');
}
