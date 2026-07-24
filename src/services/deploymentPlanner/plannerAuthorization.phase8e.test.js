const assert = require('assert');

const {
    authorizeCapabilities,
    authorizeExistenceAndGraphShadow
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

const existsCaps = (graphStatus, graphReason = 'graph') => ({
    EXISTENCE: {
        status: 'PASS',
        evidence: { destinationState: 'EXISTS', existsInDestination: true }
    },
    GRAPH: { status: graphStatus, reason: graphReason }
});

runTest('TRUST_POLICY.CustomObject is EXISTENCE + GRAPH', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomObject], [
        'EXISTENCE',
        'GRAPH'
    ]);
});

runTest('Category-A TRUST_POLICY entries remain EXISTENCE-only', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomLabel], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.CustomMetadata], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.NamedCredential], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.PermissionSet], ['EXISTENCE']);
});

runTest('CustomObject evaluates both capabilities via TRUST_POLICY', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomObject],
        capabilities: existsCaps('PASS', 'safe'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.trace.graphTrusted, true);
    assert.ok(
        auth.trace.evaluated.some(
            (entry) =>
                entry.capability === 'EXISTENCE' && entry.role === 'ACTIVE'
        )
    );
    assert.ok(
        auth.trace.evaluated.some(
            (entry) =>
                entry.capability === 'GRAPH' &&
                entry.role === 'ACTIVE' &&
                entry.trusted === true
        )
    );
});

runTest('GRAPH PASS + EXISTENCE PASS allows Skip', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomObject],
        capabilities: existsCaps('PASS', 'safe'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.canSkip, true);
});

for (const status of ['FAIL', 'UNKNOWN', 'DEFERRED', 'NOT_EVALUATED']) {
    runTest(`GRAPH ${status} prevents Skip for CustomObject trust`, () => {
        const auth = authorizeCapabilities({
            trustedCapabilities: [...TRUST_POLICY.CustomObject],
            capabilities: existsCaps(status, `graph ${status}`),
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(auth.authorized, false);
        assert.strictEqual(auth.canSkip, false);
    });
}

runTest('Category-A still ignores GRAPH FAIL', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.PermissionSet],
        capabilities: existsCaps('FAIL', 'related missing'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.trace.graphTrusted, false);
});

runTest('shadow matches CustomObject runtime TRUST_POLICY authorization', () => {
    const capabilities = existsCaps('FAIL', 'related object missing');
    const params = {
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    };

    const runtime = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomObject],
        ...params
    });
    const shadow = authorizeExistenceAndGraphShadow(params);

    assert.strictEqual(runtime.authorized, shadow.authorized);
    assert.strictEqual(runtime.canSkip, shadow.canSkip);
    assert.deepStrictEqual(runtime.reasons, shadow.reasons);
});

if (!process.exitCode) {
    console.log('Phase 8E regression: PASS');
}
