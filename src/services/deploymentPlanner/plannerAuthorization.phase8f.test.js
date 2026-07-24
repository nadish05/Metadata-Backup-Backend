const assert = require('assert');

const {
    authorizeCapabilities,
    AUTHORIZATION_AVAILABILITY
} = require('./plannerAuthorization.service');
const { TRUST_POLICY, applyPlannerOverrides } = require('./deploymentPlanner.service');

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

runTest('empty trust → UNAVAILABLE', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [],
        capabilities: existsCaps('FAIL'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(
        auth.availability,
        AUTHORIZATION_AVAILABILITY.UNAVAILABLE
    );
});

runTest('trusted EXISTENCE+GRAPH PASS → GRANTED', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomObject],
        capabilities: existsCaps('PASS', 'safe'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.availability, AUTHORIZATION_AVAILABILITY.GRANTED);
    assert.strictEqual(auth.authorized, true);
});

for (const status of ['FAIL', 'UNKNOWN', 'DEFERRED', 'NOT_EVALUATED']) {
    runTest(`trusted EXISTENCE+GRAPH ${status} → DENIED`, () => {
        const auth = authorizeCapabilities({
            trustedCapabilities: [...TRUST_POLICY.CustomObject],
            capabilities: existsCaps(status),
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(
            auth.availability,
            AUTHORIZATION_AVAILABILITY.DENIED
        );
        assert.strictEqual(auth.authorized, false);
    });
}

runTest('Category-A EXISTENCE PASS → GRANTED', () => {
    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.PermissionSet],
        capabilities: existsCaps('FAIL', 'ignored'),
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.availability, AUTHORIZATION_AVAILABILITY.GRANTED);
    assert.strictEqual(auth.authorized, true);
});

runTest('ApexClass Legacy Skip unchanged (UNAVAILABLE / useAnalyzer false)', () => {
    const { selectedMetadata, summary } = applyPlannerOverrides({
        selectedMetadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'LegacyClass',
                filePath: 'classes/LegacyClass.cls',
                selected: true,
                editable: true
            }
        ],
        resolvedDependencies: [],
        deploymentSelections: [
            {
                metadataType: 'ApexClass',
                metadataName: 'LegacyClass',
                choice: 'SKIP'
            }
        ]
    });

    assert.ok(summary.overridesApplied >= 1);
    assert.strictEqual(selectedMetadata.length, 0);
});

if (!process.exitCode) {
    console.log('Phase 8F regression: PASS');
}
