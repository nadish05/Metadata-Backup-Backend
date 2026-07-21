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

function generatePackage(selectedMetadata, decisions) {
    return deploymentPackageService.generateDeploymentPackage({
        selectedMetadata,
        requiredDependencies: decisions,
        selectedTestClasses: []
    });
}

function isIncluded(generated, type, name) {
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

const primaryController = {
    metadataType: 'ApexClass',
    metadataName: 'ComparisonResultController',
    filePath: 'classes/ComparisonResultController.cls'
};

const otherPrimary = {
    metadataType: 'ApexClass',
    metadataName: 'Primary',
    filePath: 'classes/Primary.cls'
};

runTest('A. No deploymentSelections — behaviour unchanged', () => {
    const decisions = [
        { ...optionalDeployDecision },
        { ...mandatoryDecision }
    ];
    const selectedMetadata = [{ ...otherPrimary }];

    const result = applyPlannerOverrides({
        selectedMetadata,
        resolvedDependencies: decisions,
        deploymentSelections: []
    });

    assert.strictEqual(result.selectedMetadata, selectedMetadata);
    assert.strictEqual(result.resolvedDependencies, decisions);
    assert.strictEqual(result.summary.selectionsReceived, 0);
    assert.strictEqual(result.summary.overridesApplied, 0);

    assert.deepStrictEqual(
        generatePackage(result.selectedMetadata, result.resolvedDependencies),
        generatePackage(selectedMetadata, decisions)
    );
});

runTest('B. Optional dependency Deploy — included in package', () => {
    const decisions = [
        {
            ...optionalDeployDecision,
            selected: false
        }
    ];

    const { resolvedDependencies, selectedMetadata } = applyPlannerOverrides({
        selectedMetadata: [{ ...otherPrimary }],
        resolvedDependencies: decisions,
        deploymentSelections: [
            {
                metadataType: 'CustomObject',
                metadataName: 'Optional_Object__c',
                choice: 'DEPLOY'
            }
        ]
    });

    assert.strictEqual(resolvedDependencies[0].selected, true);
    assert.strictEqual(
        isIncluded(
            generatePackage(selectedMetadata, resolvedDependencies),
            'CustomObject',
            'Optional_Object__c'
        ),
        true
    );
});

runTest('C. Optional dependency Skip — excluded from package', () => {
    const { resolvedDependencies, selectedMetadata, summary } =
        applyPlannerOverrides({
            selectedMetadata: [{ ...otherPrimary }],
            resolvedDependencies: [{ ...optionalDeployDecision }],
            deploymentSelections: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Optional_Object__c',
                    choice: 'SKIP'
                }
            ]
        });

    assert.strictEqual(summary.overridesApplied, 1);
    assert.strictEqual(resolvedDependencies[0].selected, false);
    assert.strictEqual(resolvedDependencies[0].action, 'DEPLOY');
    assert.strictEqual(
        isIncluded(
            generatePackage(selectedMetadata, resolvedDependencies),
            'CustomObject',
            'Optional_Object__c'
        ),
        false
    );
});

runTest('D. Mandatory dependency Skip — ignored, still deployed', () => {
    const { resolvedDependencies, selectedMetadata, summary } =
        applyPlannerOverrides({
            selectedMetadata: [{ ...otherPrimary }],
            resolvedDependencies: [{ ...mandatoryDecision }],
            deploymentSelections: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Mandatory_Object__c',
                    choice: 'SKIP'
                }
            ]
        });

    assert.strictEqual(summary.mandatoryIgnored, 1);
    assert.strictEqual(summary.overridesApplied, 0);
    assert.strictEqual(resolvedDependencies[0].selected, true);
    assert.strictEqual(
        isIncluded(
            generatePackage(selectedMetadata, resolvedDependencies),
            'CustomObject',
            'Mandatory_Object__c'
        ),
        true
    );
});

runTest('E. Unknown metadata — ignored safely', () => {
    const decisions = [{ ...optionalDeployDecision }];
    const selectedMetadata = [{ ...otherPrimary }];

    const result = applyPlannerOverrides({
        selectedMetadata,
        resolvedDependencies: decisions,
        deploymentSelections: [
            {
                metadataType: 'ApexClass',
                metadataName: 'DoesNotExist',
                choice: 'SKIP'
            }
        ]
    });

    assert.strictEqual(result.summary.unknownIgnored, 1);
    assert.strictEqual(result.summary.overridesApplied, 0);
    assert.strictEqual(result.selectedMetadata.length, 1);
    assert.strictEqual(result.resolvedDependencies[0].selected, true);
});

runTest('F. Primary selectedMetadata Skip — excluded from package', () => {
    const { selectedMetadata, summary } = applyPlannerOverrides({
        selectedMetadata: [{ ...primaryController }, { ...otherPrimary }],
        resolvedDependencies: [],
        deploymentSelections: [
            {
                metadataType: 'ApexClass',
                metadataName: 'ComparisonResultController',
                choice: 'SKIP'
            }
        ]
    });

    assert.ok(summary.overridesApplied >= 1);
    assert.strictEqual(selectedMetadata.length, 1);
    assert.strictEqual(selectedMetadata[0].metadataName, 'Primary');

    const generated = generatePackage(selectedMetadata, []);
    assert.strictEqual(
        isIncluded(generated, 'ApexClass', 'ComparisonResultController'),
        false
    );
    assert.strictEqual(isIncluded(generated, 'ApexClass', 'Primary'), true);
});

runTest('G. Primary selectedMetadata Deploy — remains in package', () => {
    const { selectedMetadata } = applyPlannerOverrides({
        selectedMetadata: [{ ...primaryController, selected: false }],
        resolvedDependencies: [],
        deploymentSelections: [
            {
                metadataType: 'ApexClass',
                metadataName: 'ComparisonResultController',
                choice: 'DEPLOY'
            }
        ]
    });

    assert.strictEqual(selectedMetadata.length, 1);
    assert.strictEqual(selectedMetadata[0].selected, true);
    assert.strictEqual(
        isIncluded(
            generatePackage(selectedMetadata, []),
            'ApexClass',
            'ComparisonResultController'
        ),
        true
    );
});

runTest('H. Mandatory primary selectedMetadata Skip — not removed', () => {
    const { selectedMetadata, summary } = applyPlannerOverrides({
        selectedMetadata: [
            {
                ...primaryController,
                editable: false
            }
        ],
        resolvedDependencies: [],
        deploymentSelections: [
            {
                metadataType: 'ApexClass',
                metadataName: 'ComparisonResultController',
                choice: 'SKIP'
            }
        ]
    });

    assert.strictEqual(summary.mandatoryIgnored, 1);
    assert.strictEqual(selectedMetadata.length, 1);
    assert.strictEqual(
        selectedMetadata[0].metadataName,
        'ComparisonResultController'
    );
    assert.strictEqual(
        isIncluded(
            generatePackage(selectedMetadata, []),
            'ApexClass',
            'ComparisonResultController'
        ),
        true
    );
});

runTest('Planner never mutates action / required / destinationState', () => {
    const decisions = [{ ...optionalDeployDecision }];

    const { resolvedDependencies } = applyPlannerOverrides({
        selectedMetadata: [],
        resolvedDependencies: decisions,
        deploymentSelections: [
            {
                metadataType: 'CustomObject',
                metadataName: 'Optional_Object__c',
                choice: 'SKIP'
            }
        ]
    });

    assert.strictEqual(resolvedDependencies[0].action, 'DEPLOY');
    assert.strictEqual(resolvedDependencies[0].required, true);
    assert.strictEqual(
        resolvedDependencies[0].destinationState,
        'MISSING'
    );
    assert.strictEqual(decisions[0].selected, true);
});

if (process.exitCode) {
    console.error('deploymentPlanner.service tests failed');
} else {
    console.log('deploymentPlanner.service tests passed');
}
