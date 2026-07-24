const assert = require('assert');

const {
    authorizeCapabilities,
    authorizeExistenceAndGraphShadow,
    buildCustomObjectGraphTrustShadowComparison,
    attachCustomObjectGraphTrustShadow
} = require('./plannerAuthorization.service');
const {
    TRUST_POLICY,
    authorizeCapabilities: plannerAuthorize
} = require('./deploymentPlanner.service');

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

runTest('TRUST_POLICY.CustomObject trusts EXISTENCE and GRAPH (Phase 8E)', () => {
    assert.deepStrictEqual([...TRUST_POLICY.CustomObject], [
        'EXISTENCE',
        'GRAPH'
    ]);
});

runTest('runtime authorizeCapabilities ignores GRAPH even if present', () => {
    const capabilities = {
        EXISTENCE: { status: 'PASS', reason: 'exists' },
        GRAPH: { status: 'FAIL', reason: 'related object missing' }
    };

    const auth = authorizeCapabilities({
        trustedCapabilities: [],
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.canSkip, true);
    assert.strictEqual(auth.trace.phase, '8F');
    assert.strictEqual(auth.trace.graphTrusted, false);
});

runTest('shadow denies Skip when EXISTENCE PASS and GRAPH FAIL', () => {
    const capabilities = {
        EXISTENCE: {
            status: 'PASS',
            reason: 'exists',
            evidence: { destinationState: 'EXISTS', existsInDestination: true }
        },
        GRAPH: {
            status: 'FAIL',
            reason: 'related object missing'
        }
    };

    const shadow = authorizeExistenceAndGraphShadow({
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(shadow.authorized, false);
    assert.ok(
        shadow.reasons.some((r) => /GRAPH.*(denied|failed)/i.test(r))
    );
});

runTest('shadow allows Skip when EXISTENCE PASS and GRAPH PASS', () => {
    const capabilities = {
        EXISTENCE: {
            status: 'PASS',
            evidence: { destinationState: 'EXISTS', existsInDestination: true }
        },
        GRAPH: { status: 'PASS', reason: 'Graph closure is safe.' }
    };

    const shadow = authorizeExistenceAndGraphShadow({
        capabilities,
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(shadow.authorized, true);
});

runTest('comparison reports Runtime Skip vs Shadow Deploy on GRAPH fail', () => {
    const comparison = buildCustomObjectGraphTrustShadowComparison({
        capabilities: {
            EXISTENCE: {
                status: 'PASS',
                evidence: {
                    destinationState: 'EXISTS',
                    existsInDestination: true
                }
            },
            GRAPH: {
                status: 'FAIL',
                reason: 'related object missing'
            }
        },
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE',
        existsInDestination: true
    });

    assert.strictEqual(comparison.graphTrustShadow.runtimeDecision, 'Skip');
    assert.strictEqual(comparison.graphTrustShadow.shadowDecision, 'Deploy');
    assert.strictEqual(comparison.graphTrustShadow.decisionDifference, true);
    assert.ok(
        /GRAPH.*(denied|failed)/i.test(
            comparison.graphTrustShadow.differenceReason
        )
    );
    assert.strictEqual(comparison.shadowAuthorized, false);
    assert.ok(Array.isArray(comparison.shadowReasons));
    assert.strictEqual(comparison.shadowTrace.mode, 'SHADOW');
});

runTest('comparison reports agreement when both would Skip', () => {
    const comparison = buildCustomObjectGraphTrustShadowComparison({
        capabilities: {
            EXISTENCE: {
                status: 'PASS',
                evidence: {
                    destinationState: 'EXISTS',
                    existsInDestination: true
                }
            },
            GRAPH: { status: 'PASS', reason: 'safe' }
        },
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE',
        existsInDestination: true
    });

    assert.strictEqual(comparison.graphTrustShadow.runtimeDecision, 'Skip');
    assert.strictEqual(comparison.graphTrustShadow.shadowDecision, 'Skip');
    assert.strictEqual(comparison.graphTrustShadow.decisionDifference, false);
    assert.strictEqual(
        comparison.graphTrustShadow.differenceReason,
        'Both policies agree.'
    );
});

runTest('attachCustomObjectGraphTrustShadow only shadows CustomObject rows', () => {
    const report = attachCustomObjectGraphTrustShadow({
        plannerCompatibility: {
            results: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Foo__c',
                    existsInDestination: true,
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
                            status: 'FAIL',
                            reason: 'related object missing'
                        }
                    }
                },
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'PS_A',
                    existsInDestination: true,
                    analysisLevel: 'EXISTENCE',
                    capabilities: {
                        EXISTENCE: { status: 'PASS' },
                        GRAPH: { status: 'FAIL', reason: 'n/a' }
                    }
                }
            ],
            summary: {}
        }
    });

    const [customObject, permissionSet] =
        report.plannerCompatibility.results;

    assert.strictEqual(customObject.shadowAuthorized, false);
    assert.ok(customObject.graphTrustShadow);
    assert.strictEqual(
        customObject.graphTrustShadow.runtimeDecision,
        'Skip'
    );
    assert.strictEqual(
        customObject.graphTrustShadow.shadowDecision,
        'Deploy'
    );

    assert.strictEqual(permissionSet.shadowAuthorized, undefined);
    assert.strictEqual(permissionSet.graphTrustShadow, undefined);

    assert.strictEqual(
        report.plannerCompatibility.graphTrustShadowSummary.compared,
        1
    );
    assert.strictEqual(
        report.plannerCompatibility.graphTrustShadowSummary.differences,
        1
    );
    assert.strictEqual(
        report.plannerCompatibility.graphTrustShadowSummary
            .graphTrustEnabled,
        false
    );
});

runTest('planner authorizeCapabilities export Category-A unchanged', () => {
    const auth = plannerAuthorize({
        trustedCapabilities: ['EXISTENCE'],
        capabilities: {
            EXISTENCE: { status: 'PASS' },
            GRAPH: { status: 'FAIL', reason: 'missing dep' }
        },
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.trace.phase, '8F');
    assert.strictEqual(auth.trace.graphTrusted, false);
});

if (!process.exitCode) {
    console.log('Phase 8B regression: PASS');
}
