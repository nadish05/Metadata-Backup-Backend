const assert = require('assert');

const customObjectResolver = require('./customObject.resolver');
const {
    ACTIONS,
    DESTINATION_STATES,
    RELATIONSHIPS
} = require('../decisionModel');
const {
    generateDeploymentPackage
} = require('../../deploymentPackage.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function resolveCustomObject(dependency, context = {}) {
    return customObjectResolver.resolve(dependency, {
        destinationStates: context.destinationStates || new Map(),
        selectedMetadataKeys: context.selectedMetadataKeys || new Set()
    });
}

function missingParentDependency({
    name = 'Department__c',
    relationship = RELATIONSHIPS.MASTER_DETAIL,
    required = true,
    selected = true,
    editable = undefined
} = {}) {
    const dependency = {
        type: 'CustomObject',
        name,
        relationship,
        required,
        selected
    };

    if (editable !== undefined) {
        dependency.editable = editable;
    }

    return dependency;
}

function destinationMap(name, state) {
    return new Map([[`CustomObject:${name}`, state]]);
}

async function main() {
    await runTest(
        'TEST 1: MasterDetail + MISSING + not explicitly selected → DEPLOY',
        () => {
            const decision = resolveCustomObject(
                missingParentDependency({
                    name: 'Department__c',
                    relationship: RELATIONSHIPS.MASTER_DETAIL
                }),
                {
                    destinationStates: destinationMap(
                        'Department__c',
                        DESTINATION_STATES.MISSING
                    )
                }
            );

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.required, true);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.editable, true);
            assert.strictEqual(decision.relationship, RELATIONSHIPS.MASTER_DETAIL);
            assert.strictEqual(
                decision.reason,
                'MasterDetail target is missing in destination; include object metadata in the deployment package.'
            );
        }
    );

    await runTest(
        'TEST 2: Lookup + MISSING + not explicitly selected → DEPLOY',
        () => {
            const decision = resolveCustomObject(
                missingParentDependency({
                    name: 'Department__c',
                    relationship: RELATIONSHIPS.LOOKUP
                }),
                {
                    destinationStates: destinationMap(
                        'Department__c',
                        DESTINATION_STATES.MISSING
                    )
                }
            );

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.required, true);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.editable, true);
            assert.strictEqual(decision.relationship, RELATIONSHIPS.LOOKUP);
            assert.strictEqual(
                decision.reason,
                'Lookup target is missing in destination; include object metadata in the deployment package.'
            );
        }
    );

    await runTest(
        'TEST 3: MasterDetail + EXISTS → REFERENCE',
        () => {
            const decision = resolveCustomObject(
                missingParentDependency({
                    name: 'Department__c',
                    relationship: RELATIONSHIPS.MASTER_DETAIL
                }),
                {
                    destinationStates: destinationMap(
                        'Department__c',
                        DESTINATION_STATES.EXISTS
                    )
                }
            );

            assert.strictEqual(decision.action, ACTIONS.REFERENCE);
            assert.strictEqual(decision.required, true);
            assert.strictEqual(decision.selected, false);
            assert.strictEqual(decision.editable, true);
            assert.strictEqual(
                decision.reason,
                'MasterDetail target exists in destination; validate existence only and do not deploy object metadata.'
            );
        }
    );

    await runTest(
        'TEST 4: MasterDetail + UNKNOWN preserves auto-include behavior',
        () => {
            const decision = resolveCustomObject(
                missingParentDependency({
                    name: 'Department__c',
                    relationship: RELATIONSHIPS.MASTER_DETAIL,
                    required: true,
                    selected: true
                }),
                {
                    destinationStates: destinationMap(
                        'Department__c',
                        DESTINATION_STATES.UNKNOWN
                    )
                }
            );

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.required, true);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.editable, false);
            assert.strictEqual(
                decision.destinationState,
                DESTINATION_STATES.UNKNOWN
            );
            assert.strictEqual(
                decision.reason,
                'Destination state unavailable; preserving existing auto-include behavior.'
            );
        }
    );

    await runTest(
        'TEST 5: MasterDetail + MISSING + explicitly selected → DEPLOY, not editable',
        () => {
            const decision = resolveCustomObject(
                missingParentDependency({
                    name: 'Department__c',
                    relationship: RELATIONSHIPS.MASTER_DETAIL,
                    selected: false
                }),
                {
                    destinationStates: destinationMap(
                        'Department__c',
                        DESTINATION_STATES.MISSING
                    ),
                    selectedMetadataKeys: new Set([
                        'CustomObject:Department__c'
                    ])
                }
            );

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.editable, false);
            assert.strictEqual(
                decision.reason,
                'CustomObject is explicitly selected for deployment.'
            );
        }
    );

    await runTest(
        'user-selected detection ignores discovery dependency.selected',
        () => {
            const decision = resolveCustomObject(
                missingParentDependency({
                    name: 'Department__c',
                    relationship: RELATIONSHIPS.MASTER_DETAIL,
                    selected: true
                }),
                {
                    destinationStates: destinationMap(
                        'Department__c',
                        DESTINATION_STATES.MISSING
                    ),
                    selectedMetadataKeys: new Set()
                }
            );

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.editable, true);
            assert.strictEqual(
                decision.reason,
                'MasterDetail target is missing in destination; include object metadata in the deployment package.'
            );
        }
    );

    await runTest(
        'MISSING MasterDetail parent is auto-included in generated package metadata',
        () => {
            const decision = resolveCustomObject(
                missingParentDependency({
                    name: 'Department__c',
                    relationship: RELATIONSHIPS.MASTER_DETAIL
                }),
                {
                    destinationStates: destinationMap(
                        'Department__c',
                        DESTINATION_STATES.MISSING
                    )
                }
            );

            const generated = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Course__c'
                    }
                ],
                requiredDependencies: [decision],
                selectedTestClasses: []
            });

            assert.ok(
                (generated.metadata || []).some(
                    (item) =>
                        item.metadataType === 'CustomObject' &&
                        item.metadataName === 'Department__c'
                )
            );
        }
    );

    await runTest(
        'resolver applies only to CustomObject dependencies',
        () => {
            assert.strictEqual(
                customObjectResolver.applies({
                    type: 'CustomObject',
                    name: 'Department__c'
                }),
                true
            );
            assert.strictEqual(
                customObjectResolver.applies({
                    type: 'CustomField',
                    name: 'Course__c.Department__c'
                }),
                false
            );
        }
    );

    if (process.exitCode) {
        console.error('customObject.resolver.test.js FAILED');
    } else {
        console.log('customObject.resolver.test.js PASSED');
    }
}

main();
