const assert = require('assert');

const {
    TRUST_POLICY,
    authorizeCapabilities,
    resolvePlannerDecision
} = require('../deploymentPlanner/deploymentPlanner.service');

const {
    analyzePlannerCompatibility,
    buildFlowReviewDependencyEdges
} = require('../deploymentPlannerCompatibility/deploymentPlannerCompatibility.analyzer.service');

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

runTest('TRUST_POLICY.Flow is EXISTENCE + GRAPH', () => {
    assert.deepStrictEqual([...TRUST_POLICY.Flow], ['EXISTENCE', 'GRAPH']);
});

runTest('Category-A types remain EXISTENCE-only (unchanged)', () => {
    assert.deepStrictEqual([...TRUST_POLICY.NamedCredential], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.PermissionSet], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.FlexiPage], ['EXISTENCE']);
    assert.deepStrictEqual([...TRUST_POLICY.ApexClass], []);
});

runTest('buildFlowReviewDependencyEdges uses Review sourceMetadata only', () => {
    const edges = buildFlowReviewDependencyEdges(
        [{ metadataType: 'Flow', metadataName: 'Invoice_Orchestrator' }],
        [
            {
                type: 'Flow',
                name: 'Approval_Subflow',
                sourceMetadata: 'Invoice_Orchestrator',
                discoveredBy: 'DeploymentReview',
                required: true,
                selected: true
            },
            {
                type: 'CustomField',
                name: 'Invoice__c.Amount__c',
                sourceMetadata: 'Invoice_Orchestrator',
                required: true,
                selected: true
            },
            {
                type: 'ApexClass',
                name: 'OtherClass',
                sourceMetadata: 'SomeOtherFlow',
                required: true,
                selected: true
            }
        ]
    );

    assert.strictEqual(edges.length, 2);
    assert.ok(
        edges.every(
            (edge) =>
                edge.fromType === 'Flow' &&
                edge.fromName === 'Invoice_Orchestrator'
        )
    );
});

runTest(
    'All EXISTS dependencies → Flow GRAPH PASS → planner authorization GRANTED',
    () => {
        const report = analyzePlannerCompatibility({
            selectedMetadata: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Invoice_Orchestrator',
                    destinationState: 'EXISTS'
                }
            ],
            resolvedDependencies: [
                {
                    type: 'Flow',
                    name: 'Approval_Subflow',
                    sourceMetadata: 'Invoice_Orchestrator',
                    destinationState: 'EXISTS',
                    required: true,
                    selected: false
                },
                {
                    type: 'CustomObject',
                    name: 'Invoice__c',
                    sourceMetadata: 'Invoice_Orchestrator',
                    destinationState: 'EXISTS',
                    required: true,
                    selected: false
                }
            ],
            includeGraphEvaluation: false
        });

        const flowRow = report.plannerCompatibility.results.find(
            (row) =>
                row.metadataType === 'Flow' &&
                row.metadataName === 'Invoice_Orchestrator'
        );

        assert.ok(flowRow);
        assert.strictEqual(flowRow.capabilities.GRAPH.status, 'PASS');
        assert.strictEqual(flowRow.graphSafe, true);

        const auth = authorizeCapabilities({
            trustedCapabilities: [...TRUST_POLICY.Flow],
            capabilities: flowRow.capabilities,
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(auth.authorized, true);
        assert.strictEqual(auth.availability, 'GRANTED');
    }
);

runTest(
    'MISSING required dependency (not in package) → GRAPH FAIL → DENIED',
    () => {
        const report = analyzePlannerCompatibility({
            selectedMetadata: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Invoice_Orchestrator',
                    destinationState: 'EXISTS'
                }
            ],
            resolvedDependencies: [
                {
                    type: 'CustomField',
                    name: 'Invoice__c.Amount__c',
                    sourceMetadata: 'Invoice_Orchestrator',
                    destinationState: 'MISSING',
                    required: true,
                    selected: false
                }
            ],
            includeGraphEvaluation: false
        });

        const flowRow = report.plannerCompatibility.results.find(
            (row) => row.metadataType === 'Flow'
        );

        assert.strictEqual(flowRow.capabilities.GRAPH.status, 'FAIL');
        assert.strictEqual(flowRow.graphSafe, false);

        const auth = authorizeCapabilities({
            trustedCapabilities: [...TRUST_POLICY.Flow],
            capabilities: flowRow.capabilities,
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(auth.authorized, false);
        assert.strictEqual(auth.availability, 'DENIED');
    }
);

runTest(
    'UNKNOWN required dependency → GRAPH UNKNOWN → DENIED',
    () => {
        const report = analyzePlannerCompatibility({
            selectedMetadata: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Invoice_Orchestrator',
                    destinationState: 'EXISTS'
                }
            ],
            resolvedDependencies: [
                {
                    type: 'EmailAlert',
                    name: 'Invoice__c.Invoice_Manager_Email',
                    sourceMetadata: 'Invoice_Orchestrator',
                    destinationState: 'UNKNOWN',
                    required: true,
                    selected: false
                }
            ],
            includeGraphEvaluation: false
        });

        const flowRow = report.plannerCompatibility.results.find(
            (row) => row.metadataType === 'Flow'
        );

        assert.strictEqual(flowRow.capabilities.GRAPH.status, 'UNKNOWN');

        const auth = authorizeCapabilities({
            trustedCapabilities: [...TRUST_POLICY.Flow],
            capabilities: flowRow.capabilities,
            destinationState: 'EXISTS',
            analysisLevel: 'EXISTENCE'
        });

        assert.strictEqual(auth.authorized, false);
        assert.strictEqual(auth.availability, 'DENIED');
    }
);

runTest(
    'CustomObject graph remains deferred when includeGraphEvaluation is false',
    () => {
        const report = analyzePlannerCompatibility({
            selectedMetadata: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Invoice__c',
                    destinationState: 'EXISTS'
                },
                {
                    metadataType: 'Flow',
                    metadataName: 'Invoice_Orchestrator',
                    destinationState: 'EXISTS'
                }
            ],
            resolvedDependencies: [],
            includeGraphEvaluation: false
        });

        const objectRow = report.plannerCompatibility.results.find(
            (row) => row.metadataType === 'CustomObject'
        );
        const flowRow = report.plannerCompatibility.results.find(
            (row) => row.metadataType === 'Flow'
        );

        assert.strictEqual(objectRow.capabilities.GRAPH.status, 'DEFERRED');
        assert.notStrictEqual(flowRow.capabilities.GRAPH.status, 'DEFERRED');
    }
);

runTest('resolvePlannerDecision routes Flow to Analyzer', () => {
    const resolved = resolvePlannerDecision({
        metadataItem: {
            metadataType: 'Flow',
            metadataName: 'Invoice_Orchestrator',
            destinationState: 'EXISTS'
        },
        plannerCompatibilityRow: {
            metadataType: 'Flow',
            metadataName: 'Invoice_Orchestrator',
            analysisLevel: 'EXISTENCE',
            destinationState: 'EXISTS',
            capabilities: {
                EXISTENCE: { status: 'PASS', authorizationReady: true },
                GRAPH: { status: 'PASS', authorizationReady: true }
            }
        }
    });

    assert.strictEqual(resolved.useAnalyzer, true);
    assert.strictEqual(resolved.canSkip, true);
    assert.deepStrictEqual(resolved.trace.trustedLevels, [
        'EXISTENCE',
        'GRAPH'
    ]);
});
