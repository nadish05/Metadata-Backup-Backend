const assert = require('assert');

const {
    authorizeCapabilities,
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
            evidence: {
                destinationState,
                existsInDestination: destinationState === 'EXISTS'
            }
        },
        GRAPH: { status: graph, reason: `graph ${graph}` },
        CONTRACT: {
            status: contract,
            reason: `contract ${contract}`,
            evidence: { rulesChecked: ['FIELD_TYPE'], mismatches: [] }
        }
    };
}

runTest('TRUST_POLICY.CustomField is EXISTENCE + GRAPH + CONTRACT', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomField], [
        'EXISTENCE',
        'GRAPH',
        'CONTRACT'
    ]);
});

runTest('CustomObject TRUST_POLICY unchanged', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomObject], [
        'EXISTENCE',
        'GRAPH'
    ]);
    assert.ok(!TRUST_POLICY.CustomObject.includes('CONTRACT'));
});

runTest('Category-A TRUST_POLICY entries remain EXISTENCE-only', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomLabel], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.CustomMetadata], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.NamedCredential], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.PermissionSet], ['EXISTENCE']);
});

runTest('CustomField grants Skip when EXISTENCE+GRAPH+CONTRACT PASS', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomField],
        capabilities: caps({ contract: 'PASS', graph: 'PASS' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.availability, AUTHORIZATION_AVAILABILITY.GRANTED);
    assert.strictEqual(auth.trace.graphTrusted, true);
    assert.strictEqual(auth.trace.contractTrusted, true);
});

for (const status of ['FAIL', 'UNKNOWN', 'DEFERRED', 'NOT_EVALUATED']) {
    runTest(`CustomField denies Skip when CONTRACT ${status}`, () => {
        const auth = authorizeCapabilities({
            trustedCapabilities: [...TRUST_POLICY.CustomField],
            capabilities: caps({ contract: status, graph: 'PASS' }),
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(auth.authorized, false);
        assert.strictEqual(auth.canSkip, false);
        assert.strictEqual(auth.availability, AUTHORIZATION_AVAILABILITY.DENIED);
        assert.ok(
            auth.reasons.some((r) =>
                /Authorization DENIED: CONTRACT capability failed/i.test(r)
            )
        );
    });
}

runTest('CustomField denies Skip when GRAPH FAIL (GRAPH unchanged)', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomField],
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

runTest('CustomObject still ignores CONTRACT FAIL', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomObject],
        capabilities: caps({ graph: 'PASS', contract: 'FAIL' }),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.trace.contractTrusted, false);
});

if (!process.exitCode) {
    console.log('Phase 9G regression: PASS');
}
