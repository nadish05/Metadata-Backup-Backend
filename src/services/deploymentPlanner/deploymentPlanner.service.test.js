const assert = require('assert');

const {
    applyPlannerOverrides
} = require('./deploymentPlanner.service');
const deploymentPackageService = require('../deploymentPackage.service');

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

function generateFromDecisions(decisions) {
    return deploymentPackageService.generateDeploymentPackage({
        selectedMetadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'Primary',
                filePath: 'classes/Primary.cls'
            }
        ],
        requiredDependencies: decisions,
        selectedTestClasses: []
    });
}

function isDependencyIncluded(generated, type, name) {
    return (generated.metadata || []).some(
        (item) =>
            item.metadataType === type && item.metadataName === name
    );
}

const optionalDeployDecision = {
    name: 'Optional_Object__c',
    metadataType: 'CustomObject',
    type: 'CustomObject',
    action: 'DEPLOY',
    required: true,
    selected: true,
    editable: true,
    destinationState: 'MISSING',
    relationship: 'Lookup',
    reason: 'optional missing lookup',
    source: 'RESOLVER'
};

const mandatoryDecision = {
    name: 'Mandatory_Object__c',
    metadataType: 'CustomObject',
    type: 'CustomObject',
    action: 'DEPLOY',
    required: true,
    selected: true,
    editable: false,
    destinationState: 'MISSING',
    relationship: null,
    reason: 'explicitly selected',
    source: 'RESOLVER'
};

runTest('A. No deploymentSelections — behaviour unchanged', () => {
    const decisions = [
        { ...optionalDeployDecision },
        { ...mandatoryDecision }
    ];

    const result = applyPlannerOverrides(decisions, []);

    assert.strictEqual(result.resolvedDependencies, decisions);
    assert.strictEqual(result.summary.selectionsReceived, 0);
    assert.strictEqual(result.summary.overridesApplied, 0);

    const withoutPlanner = generateFromDecisions(decisions);
    const withEmptyPlanner = generateFromDecisions(
        result.resolvedDependencies
    );

    assert.deepStrictEqual(withEmptyPlanner, withoutPlanner);
    assert.strictEqual(
        isDependencyIncluded(
            withEmptyPlanner,
            'CustomObject',
            'Optional_Object__c'
        ),
        true
    );
});

runTest('B. Optional metadata Deploy — included in package', () => {
    const decisions = [
        {
            ...optionalDeployDecision,
            selected: false
        }
    ];

    const { resolvedDependencies } = applyPlannerOverrides(decisions, [
        {
            metadataType: 'CustomObject',
            metadataName: 'Optional_Object__c',
            choice: 'DEPLOY'
        }
    ]);

    assert.strictEqual(resolvedDependencies[0].selected, true);
    assert.strictEqual(resolvedDependencies[0].action, 'DEPLOY');
    assert.strictEqual(resolvedDependencies[0].editable, true);

    const generated = generateFromDecisions(resolvedDependencies);
    assert.strictEqual(
        isDependencyIncluded(
            generated,
            'CustomObject',
            'Optional_Object__c'
        ),
        true
    );
});

runTest('C. Optional metadata Skip — excluded from package', () => {
    const decisions = [{ ...optionalDeployDecision }];

    const { resolvedDependencies, summary } = applyPlannerOverrides(
        decisions,
        [
            {
                metadataType: 'CustomObject',
                metadataName: 'Optional_Object__c',
                choice: 'SKIP'
            }
        ]
    );

    assert.strictEqual(summary.overridesApplied, 1);
    assert.strictEqual(resolvedDependencies[0].selected, false);
    assert.strictEqual(resolvedDependencies[0].action, 'DEPLOY');
    assert.strictEqual(resolvedDependencies[0].required, true);
    assert.strictEqual(
        resolvedDependencies[0].destinationState,
        'MISSING'
    );

    const generated = generateFromDecisions(resolvedDependencies);
    assert.strictEqual(
        isDependencyIncluded(
            generated,
            'CustomObject',
            'Optional_Object__c'
        ),
        false
    );
});

runTest('D. Mandatory metadata Skip — ignored, still deployed', () => {
    const decisions = [{ ...mandatoryDecision }];

    const { resolvedDependencies, summary } = applyPlannerOverrides(
        decisions,
        [
            {
                metadataType: 'CustomObject',
                metadataName: 'Mandatory_Object__c',
                choice: 'SKIP'
            }
        ]
    );

    assert.strictEqual(summary.mandatoryIgnored, 1);
    assert.strictEqual(summary.overridesApplied, 0);
    assert.strictEqual(resolvedDependencies[0].selected, true);
    assert.strictEqual(resolvedDependencies[0].editable, false);

    const generated = generateFromDecisions(resolvedDependencies);
    assert.strictEqual(
        isDependencyIncluded(
            generated,
            'CustomObject',
            'Mandatory_Object__c'
        ),
        true
    );
});

runTest('E. Unknown metadata — ignored safely', () => {
    const decisions = [{ ...optionalDeployDecision }];

    const { resolvedDependencies, summary } = applyPlannerOverrides(
        decisions,
        [
            {
                metadataType: 'ApexClass',
                metadataName: 'DoesNotExist',
                choice: 'SKIP'
            }
        ]
    );

    assert.strictEqual(summary.unknownIgnored, 1);
    assert.strictEqual(summary.overridesIgnored, 1);
    assert.strictEqual(summary.overridesApplied, 0);
    assert.deepStrictEqual(resolvedDependencies[0], {
        ...optionalDeployDecision
    });
});

runTest('Planner never mutates action / required / destinationState', () => {
    const decisions = [{ ...optionalDeployDecision }];

    const { resolvedDependencies } = applyPlannerOverrides(decisions, [
        {
            metadataType: 'CustomObject',
            metadataName: 'Optional_Object__c',
            choice: 'SKIP'
        }
    ]);

    assert.strictEqual(resolvedDependencies[0].action, 'DEPLOY');
    assert.strictEqual(resolvedDependencies[0].required, true);
    assert.strictEqual(
        resolvedDependencies[0].destinationState,
        'MISSING'
    );
    assert.strictEqual(resolvedDependencies[0].relationship, 'Lookup');
    assert.strictEqual(resolvedDependencies[0].source, 'RESOLVER');
    assert.notStrictEqual(resolvedDependencies[0], decisions[0]);
    assert.strictEqual(decisions[0].selected, true);
});

if (process.exitCode) {
    console.error('deploymentPlanner.service tests failed');
} else {
    console.log('deploymentPlanner.service tests passed');
}
