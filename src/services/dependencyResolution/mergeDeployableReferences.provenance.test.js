const assert = require('assert');

const {
    mergeDeployableReferences,
    resolveDependencies,
    ACTIONS
} = require('./dependencyResolution.service');
const structuralActionOverrideFieldResolver = require('./resolvers/structuralActionOverrideField.resolver');
const { DISCOVERY_METHOD } = require('./graphExpansion/structuralActionOverrideField.discoverer');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

const STRUCTURAL_FIELD_REFERENCE = {
    name: 'Subscription__c.Price__c',
    metadataType: 'CustomField',
    type: 'CustomField',
    deployable: true,
    blocking: true,
    discoveryMethod: DISCOVERY_METHOD,
    sourceMetadata: 'Subscription_Record_Page',
    sourceField: 'Price__c',
    relationship: 'Field',
    reason:
        'CustomField referenced by structural FlexiPage action override Subscription_Record_Page.',
    discoveredBy: 'CustomObjectStructuralDependencies'
};

async function main() {
    await runTest(
        'mergeDeployableReferences preserves structuralActionOverrideField provenance',
        () => {
            const merged = mergeDeployableReferences([], [STRUCTURAL_FIELD_REFERENCE]);
            const dependency = merged.find(
                (item) => item.name === 'Subscription__c.Price__c'
            );

            assert.ok(dependency);
            assert.strictEqual(dependency.discoveryMethod, DISCOVERY_METHOD);
            assert.strictEqual(
                dependency.sourceMetadata,
                'Subscription_Record_Page'
            );
            assert.strictEqual(dependency.sourceField, 'Price__c');
            assert.strictEqual(dependency.relationship, 'Field');
        }
    );

    await runTest(
        'structuralActionOverrideFieldResolver SKIP when destination EXISTS',
        () => {
            const decision = structuralActionOverrideFieldResolver.resolve(
                {
                    type: 'CustomField',
                    name: 'Subscription__c.Price__c',
                    discoveryMethod: DISCOVERY_METHOD,
                    sourceMetadata: 'Subscription_Record_Page',
                    relationship: 'Field'
                },
                {
                    destinationStates: new Map([
                        ['CustomField:Subscription__c.Price__c', 'EXISTS']
                    ])
                }
            );

            assert.strictEqual(decision.action, ACTIONS.SKIP);
            assert.strictEqual(decision.selected, false);
            assert.strictEqual(decision.destinationState, 'EXISTS');
        }
    );

    await runTest(
        'structuralActionOverrideFieldResolver DEPLOY when destination MISSING',
        () => {
            const decision = structuralActionOverrideFieldResolver.resolve(
                {
                    type: 'CustomField',
                    name: 'Subscription__c.Remaining_Sessions__c',
                    discoveryMethod: DISCOVERY_METHOD,
                    sourceMetadata: 'Subscription_Record_Page',
                    relationship: 'Field'
                },
                {
                    destinationStates: new Map([
                        [
                            'CustomField:Subscription__c.Remaining_Sessions__c',
                            'MISSING'
                        ]
                    ])
                }
            );

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.destinationState, 'MISSING');
        }
    );

    await runTest(
        'resolveDependencies applies structuralActionOverrideField resolver after merge',
        async () => {
            const merged = mergeDeployableReferences([], [
                STRUCTURAL_FIELD_REFERENCE
            ]);

            const existsResolution = await resolveDependencies({
                requiredDependencies: merged,
                destinationStates: new Map([
                    ['CustomField:Subscription__c.Price__c', 'EXISTS']
                ])
            });

            const existsDecision = existsResolution.resolvedDependencies.find(
                (item) => item.name === 'Subscription__c.Price__c'
            );

            assert.ok(existsDecision);
            assert.strictEqual(existsDecision.action, ACTIONS.SKIP);
            assert.strictEqual(existsDecision.selected, false);

            const missingResolution = await resolveDependencies({
                requiredDependencies: mergeDeployableReferences([], [
                    {
                        ...STRUCTURAL_FIELD_REFERENCE,
                        name: 'Subscription__c.Remaining_Sessions__c'
                    }
                ]),
                destinationStates: new Map([
                    [
                        'CustomField:Subscription__c.Remaining_Sessions__c',
                        'MISSING'
                    ]
                ])
            });

            const missingDecision = missingResolution.resolvedDependencies.find(
                (item) => item.name === 'Subscription__c.Remaining_Sessions__c'
            );

            assert.ok(missingDecision);
            assert.strictEqual(missingDecision.action, ACTIONS.DEPLOY);
            assert.strictEqual(missingDecision.selected, true);
        }
    );

    if (process.exitCode) {
        console.error('mergeDeployableReferences.provenance.test.js FAILED');
    } else {
        console.log('mergeDeployableReferences.provenance.test.js PASSED');
    }
}

main();
