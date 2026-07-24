const assert = require('assert');

const {
    authorizeCapabilities,
    authorizeExistenceGraphAndContractShadow,
    ACTIVE_AUTHORIZATION_CAPABILITIES,
    PASSIVE_AUTHORIZATION_CAPABILITIES,
    AUTHORIZATION_AVAILABILITY
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

runTest('TRUST_POLICY: CustomField trusts CONTRACT; CustomObject unchanged', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomField], [
        'EXISTENCE',
        'GRAPH',
        'CONTRACT'
    ]);
    assert.deepStrictEqual([...TRUST_POLICY.CustomObject], [
        'EXISTENCE',
        'GRAPH'
    ]);
    assert.ok(!TRUST_POLICY.CustomObject.includes('CONTRACT'));
});

runTest('ACTIVE includes CONTRACT; PASSIVE is SEMANTIC only', () => {
    assert.deepStrictEqual([...ACTIVE_AUTHORIZATION_CAPABILITIES], [
        'EXISTENCE',
        'GRAPH',
        'CONTRACT'
    ]);
    assert.deepStrictEqual([...PASSIVE_AUTHORIZATION_CAPABILITIES], [
        'SEMANTIC'
    ]);
});

runTest('trusted EXISTENCE+GRAPH+CONTRACT grants when all PASS', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH', 'CONTRACT'],
        capabilities: caps({ contract: 'PASS', graph: 'PASS' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.availability, AUTHORIZATION_AVAILABILITY.GRANTED);
    assert.strictEqual(auth.trace.contractTrusted, true);
    assert.ok(
        auth.reasons.some((r) => /CONTRACT policy: status PASS/i.test(r))
    );
    assert.ok(
        auth.reasons.some((r) =>
            /EXISTENCE AND GRAPH AND CONTRACT all PASS/i.test(r)
        )
    );
});

for (const status of ['FAIL', 'UNKNOWN', 'DEFERRED', 'NOT_EVALUATED']) {
    runTest(`trusted CONTRACT denies when CONTRACT ${status}`, () => {
        const auth = authorizeCapabilities({
            trustedCapabilities: ['EXISTENCE', 'GRAPH', 'CONTRACT'],
            capabilities: caps({ contract: status, graph: 'PASS' }),
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(auth.authorized, false);
        assert.strictEqual(auth.canSkip, false);
        assert.strictEqual(auth.availability, AUTHORIZATION_AVAILABILITY.DENIED);
        assert.ok(
            auth.reasons.some((r) =>
                new RegExp(
                    `CONTRACT policy: authorization denied \\(status=${status}\\)`,
                    'i'
                ).test(r)
            )
        );
        assert.ok(
            auth.reasons.some((r) =>
                /Authorization DENIED: CONTRACT capability failed/i.test(r)
            )
        );
    });
}

runTest('EXISTENCE+GRAPH trust ignores CONTRACT FAIL (CustomObject path)', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH'],
        capabilities: caps({ contract: 'FAIL', graph: 'PASS' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.trace.contractTrusted, false);
    const contractEval = auth.trace.evaluated.find(
        (e) => e.capability === 'CONTRACT'
    );
    assert.strictEqual(contractEval.role, 'PASSIVE');
});

runTest('GRAPH behavior unchanged when GRAPH FAIL with CONTRACT trusted', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH', 'CONTRACT'],
        capabilities: caps({ graph: 'FAIL', contract: 'PASS' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, false);
    assert.ok(
        auth.reasons.some((r) =>
            /Authorization DENIED: GRAPH capability failed/i.test(r)
        )
    );
});

runTest('EXISTENCE behavior unchanged when destination MISSING', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH', 'CONTRACT'],
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
        analysisLevel: 'NONE'
    });

    assert.strictEqual(auth.authorized, false);
    assert.ok(
        auth.reasons.some((r) =>
            /Authorization DENIED: EXISTENCE capability failed/i.test(r)
        )
    );
});

runTest('shadow delegates to helper (no wrapper AND)', () => {
    const trusted = ['EXISTENCE', 'GRAPH', 'CONTRACT'];
    const capabilities = caps({ contract: 'FAIL', graph: 'PASS' });

    const helper = authorizeCapabilities({
        trustedCapabilities: trusted,
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    const shadow = authorizeExistenceGraphAndContractShadow({
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(shadow.authorized, helper.authorized);
    assert.strictEqual(shadow.canSkip, helper.canSkip);
    assert.strictEqual(shadow.availability, helper.availability);
    assert.deepStrictEqual(shadow.reasons, helper.reasons);
    assert.strictEqual(shadow.trace.mode, 'SHADOW');
    assert.strictEqual(shadow.trace.phase, '9D');
    assert.strictEqual(shadow.authorized, false);
});

runTest('shadow equals helper when all PASS', () => {
    const capabilities = caps({ contract: 'PASS', graph: 'PASS' });

    const helper = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH', 'CONTRACT'],
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    const shadow = authorizeExistenceGraphAndContractShadow({
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(shadow.authorized, true);
    assert.strictEqual(shadow.authorized, helper.authorized);
    assert.deepStrictEqual(shadow.reasons, helper.reasons);
});

if (!process.exitCode) {
    console.log('Phase 9F regression: PASS');
}
