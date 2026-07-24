const assert = require('assert');

const {
    authorizeCapabilities,
    authorizeExistenceAndGraphShadow,
    ACTIVE_AUTHORIZATION_CAPABILITIES
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

runTest('TRUST_POLICY: only CustomObject trusts GRAPH', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomObject], [
        'EXISTENCE',
        'GRAPH'
    ]);

    for (const [type, trusted] of Object.entries(TRUST_POLICY)) {
        if (type === 'CustomObject') {
            continue;
        }

        assert.ok(
            !trusted.includes('GRAPH'),
            `${type} must not trust GRAPH`
        );
    }
});

runTest('ACTIVE capabilities include EXISTENCE and GRAPH', () => {
    assert.deepStrictEqual([...ACTIVE_AUTHORIZATION_CAPABILITIES], [
        'EXISTENCE',
        'GRAPH'
    ]);
});

runTest('Category-A EXISTENCE-only trust ignores GRAPH FAIL', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE'],
        capabilities: existsCaps('FAIL', 'related object missing'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.canSkip, true);
    assert.strictEqual(auth.trace.graphTrusted, false);
    const graphEval = auth.trace.evaluated.find((e) => e.capability === 'GRAPH');
    assert.strictEqual(graphEval.role, 'PASSIVE');
});

runTest('empty trust ignores GRAPH FAIL (policy without GRAPH)', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [],
        capabilities: existsCaps('FAIL', 'related object missing'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
});

runTest('trusted EXISTENCE+GRAPH grants when GRAPH PASS', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH'],
        capabilities: existsCaps('PASS', 'safe'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.trace.graphTrusted, true);
    assert.ok(
        auth.reasons.some((r) => /GRAPH policy: status PASS/i.test(r))
    );
});

for (const status of ['FAIL', 'UNKNOWN', 'DEFERRED', 'NOT_EVALUATED']) {
    runTest(`trusted EXISTENCE+GRAPH denies when GRAPH ${status}`, () => {
        const auth = authorizeCapabilities({
            trustedCapabilities: ['EXISTENCE', 'GRAPH'],
            capabilities: existsCaps(status, `graph ${status}`),
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(auth.authorized, false);
        assert.strictEqual(auth.canSkip, false);
        assert.ok(
            auth.reasons.some((r) =>
                new RegExp(
                    `GRAPH policy: authorization denied \\(status=${status}\\)`,
                    'i'
                ).test(r)
            )
        );
        assert.ok(
            auth.reasons.some((r) =>
                /Authorization DENIED: GRAPH capability failed/i.test(r)
            )
        );
    });
}

runTest('missing GRAPH capability treated as NOT_EVALUATED deny when trusted', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH'],
        capabilities: {
            EXISTENCE: { status: 'PASS' }
        },
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, false);
    assert.ok(
        auth.reasons.some((r) =>
            /status=NOT_EVALUATED/i.test(r)
        )
    );
});

runTest('shadow equals active authorizeCapabilities for EXISTENCE+GRAPH', () => {
    const capabilities = existsCaps('FAIL', 'related object missing');
    const params = {
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    };

    const active = authorizeCapabilities({
        trustedCapabilities: ['EXISTENCE', 'GRAPH'],
        ...params
    });
    const shadow = authorizeExistenceAndGraphShadow(params);

    assert.strictEqual(shadow.authorized, active.authorized);
    assert.strictEqual(shadow.canSkip, active.canSkip);
    assert.deepStrictEqual(shadow.reasons, active.reasons);
    assert.strictEqual(shadow.trace.mode, 'SHADOW');
    assert.strictEqual(shadow.trace.phase, '8F');
});

if (!process.exitCode) {
    console.log('Phase 8D regression: PASS');
}
