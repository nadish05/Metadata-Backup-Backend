const assert = require('assert');

const {
    authorizeCapabilities,
    authorizeExistenceGraphAndContractShadow,
    buildCustomFieldContractTrustShadowComparison,
    attachCustomFieldContractTrustShadow,
    PASSIVE_AUTHORIZATION_CAPABILITIES
} = require('./plannerAuthorization.service');
const { TRUST_POLICY } = require('./deploymentPlanner.service');

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

function caps({
    existence = 'PASS',
    graph = 'PASS',
    contract = 'PASS',
    destinationState = 'EXISTS'
} = {}) {
    return {
        EXISTENCE: {
            status: existence,
            evidence: { destinationState, existsInDestination: true }
        },
        GRAPH: { status: graph, reason: `graph ${graph}` },
        CONTRACT: {
            status: contract,
            reason: `contract ${contract}`,
            evidence: { rulesChecked: ['FIELD_TYPE'], mismatches: [] }
        }
    };
}

runTest('TRUST_POLICY.CustomField does not trust CONTRACT', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomField], []);
    assert.ok(!TRUST_POLICY.CustomField.includes('CONTRACT'));
});

runTest('CONTRACT remains passive in runtime authorizeCapabilities', () => {
    assert.ok(PASSIVE_AUTHORIZATION_CAPABILITIES.includes('CONTRACT'));

    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH', 'CONTRACT'],
        capabilities: caps({ contract: 'FAIL' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    // Runtime helper ignores CONTRACT (passive) — still GRANTED if EXISTENCE+GRAPH PASS.
    assert.strictEqual(auth.authorized, true);
});

runTest('shadow denies Skip when CONTRACT FAIL', () => {
    const shadow = authorizeExistenceGraphAndContractShadow({
        capabilities: caps({ contract: 'FAIL' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(shadow.authorized, false);
    assert.ok(
        shadow.reasons.some((reason) => /CONTRACT.*(denied|failed)/i.test(reason))
    );
    assert.strictEqual(shadow.trace.mode, 'SHADOW');
    assert.strictEqual(shadow.trace.phase, '9D');
});

for (const status of ['UNKNOWN', 'DEFERRED', 'NOT_EVALUATED']) {
    runTest(`shadow denies Skip when CONTRACT ${status}`, () => {
        const shadow = authorizeExistenceGraphAndContractShadow({
            capabilities: caps({ contract: status }),
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(shadow.authorized, false);
    });
}

runTest('shadow allows Skip when EXISTENCE+GRAPH+CONTRACT PASS', () => {
    const shadow = authorizeExistenceGraphAndContractShadow({
        capabilities: caps({ contract: 'PASS', graph: 'PASS' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(shadow.authorized, true);
});

runTest('comparison Runtime Skip vs Shadow Deploy on CONTRACT FAIL', () => {
    const comparison = buildCustomFieldContractTrustShadowComparison({
        capabilities: caps({ contract: 'FAIL', graph: 'PASS' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE',
        existsInDestination: true
    });

    assert.strictEqual(
        comparison.contractTrustShadow.runtimeDecision,
        'Skip'
    );
    assert.strictEqual(
        comparison.contractTrustShadow.shadowDecision,
        'Deploy'
    );
    assert.strictEqual(
        comparison.contractTrustShadow.decisionDifference,
        true
    );
    assert.ok(
        /CONTRACT/i.test(comparison.contractTrustShadow.differenceReason)
    );
});

runTest('comparison agrees when both Deploy (EXISTENCE fail)', () => {
    const comparison = buildCustomFieldContractTrustShadowComparison({
        capabilities: {
            EXISTENCE: {
                status: 'FAIL',
                evidence: {
                    destinationState: 'MISSING',
                    existsInDestination: false
                }
            },
            GRAPH: { status: 'PASS' },
            CONTRACT: { status: 'PASS' }
        },
        destinationState: 'MISSING',
        analysisLevel: 'NONE',
        existsInDestination: false
    });

    assert.strictEqual(
        comparison.contractTrustShadow.runtimeDecision,
        'Deploy'
    );
    assert.strictEqual(
        comparison.contractTrustShadow.shadowDecision,
        'Deploy'
    );
    assert.strictEqual(
        comparison.contractTrustShadow.decisionDifference,
        false
    );
});

runTest('attachCustomFieldContractTrustShadow only shadows CustomField', () => {
    const report = attachCustomFieldContractTrustShadow({
        plannerCompatibility: {
            results: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Status__c',
                    existsInDestination: true,
                    analysisLevel: 'EXISTENCE',
                    capabilities: caps({ contract: 'FAIL', graph: 'PASS' })
                },
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Account',
                    existsInDestination: true,
                    analysisLevel: 'EXISTENCE',
                    capabilities: caps({ contract: 'FAIL', graph: 'PASS' })
                }
            ],
            summary: {}
        }
    });

    const [customField, customObject] =
        report.plannerCompatibility.results;

    assert.strictEqual(customField.shadowAuthorized, false);
    assert.ok(customField.contractTrustShadow);
    assert.strictEqual(
        customField.contractTrustShadow.runtimeDecision,
        'Skip'
    );
    assert.strictEqual(
        customField.contractTrustShadow.shadowDecision,
        'Deploy'
    );

    assert.strictEqual(customObject.contractTrustShadow, undefined);

    assert.strictEqual(
        report.plannerCompatibility.contractTrustShadowSummary.compared,
        1
    );
    assert.strictEqual(
        report.plannerCompatibility.contractTrustShadowSummary.differences,
        1
    );
    assert.strictEqual(
        report.plannerCompatibility.contractTrustShadowSummary
            .contractTrustEnabled,
        false
    );
});

if (!process.exitCode) {
    console.log('Phase 9D regression: PASS');
}
