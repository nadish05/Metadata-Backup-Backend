const assert = require('assert');

const {
    collectDestinationInventoryItems
} = require('./destinationInventoryCandidateCollector.service');
const {
    buildDestinationInventory,
    toDestinationStateMap
} = require('./destinationInventoryBuilder.service');

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

function itemKeys(items) {
    return (items || []).map((item) => `${item.metadataType}:${item.metadataName}`);
}

function hasCandidate(items, metadataType, metadataName) {
    return itemKeys(items).includes(`${metadataType}:${metadataName}`);
}

async function main() {
    await runTest(
        'TEST 1: selected/required/discovered inventory behavior unchanged',
        async () => {
            const selected = [
                { metadataType: 'Layout', metadataName: 'Account-Gym Member Layout' }
            ];
            const required = [
                { type: 'CustomObject', name: 'Payment__c' },
                { metadataType: 'CustomField', metadataName: 'Payment__c.Account__c' }
            ];
            const discovered = [
                {
                    metadataType: 'CustomObject',
                    name: 'Gym_Trainer__c',
                    deployable: true
                }
            ];

            const items = collectDestinationInventoryItems({
                selectedMetadata: selected,
                requiredDependencies: required,
                discoveredReferences: discovered
            });

            assert.strictEqual(items.length, 4);
            assert.ok(hasCandidate(items, 'Layout', 'Account-Gym Member Layout'));
            assert.ok(hasCandidate(items, 'CustomObject', 'Payment__c'));
            assert.ok(hasCandidate(items, 'CustomField', 'Payment__c.Account__c'));
            assert.ok(hasCandidate(items, 'CustomObject', 'Gym_Trainer__c'));
        }
    );

    await runTest(
        'TEST 2: closure candidate CustomField Membership_Plan__c.Sessions_Limit__c',
        async () => {
            const items = collectDestinationInventoryItems({
                closureCandidates: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Membership_Plan__c.Sessions_Limit__c'
                    }
                ]
            });

            assert.strictEqual(items.length, 1);
            assert.ok(
                hasCandidate(
                    items,
                    'CustomField',
                    'Membership_Plan__c.Sessions_Limit__c'
                )
            );
        }
    );

    await runTest(
        'TEST 3: closure candidate LightningComponentBundle refundPayment',
        async () => {
            const items = collectDestinationInventoryItems({
                closureCandidates: [
                    {
                        metadataType: 'LightningComponentBundle',
                        metadataName: 'refundPayment'
                    }
                ]
            });

            assert.strictEqual(items.length, 1);
            assert.ok(
                hasCandidate(items, 'LightningComponentBundle', 'refundPayment')
            );
        }
    );

    await runTest(
        'TEST 4: closure candidate ApexClass PaymentRefundController',
        async () => {
            const items = collectDestinationInventoryItems({
                closureCandidates: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'PaymentRefundController'
                    }
                ]
            });

            assert.strictEqual(items.length, 1);
            assert.ok(
                hasCandidate(items, 'ApexClass', 'PaymentRefundController')
            );
        }
    );

    await runTest('TEST 5: duplicate candidate is collected only once', async () => {
        const items = collectDestinationInventoryItems({
            discoveredReferences: [
                {
                    metadataType: 'ApexClass',
                    name: 'PaymentRefundController'
                }
            ],
            closureCandidates: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'PaymentRefundController'
                },
                {
                    type: 'ApexClass',
                    name: 'PaymentRefundController'
                }
            ]
        });

        assert.strictEqual(items.length, 1);
        assert.ok(hasCandidate(items, 'ApexClass', 'PaymentRefundController'));
    });

    await runTest(
        'TEST 6: non-deployable/platform-only closure candidate is excluded',
        async () => {
            const items = collectDestinationInventoryItems({
                closureCandidates: [
                    {
                        metadataType: 'RelatedList',
                        metadataName: 'Payments__r',
                        deployable: false
                    },
                    {
                        metadataType: 'RelationshipReference',
                        metadataName: 'SomeRuntimeToken'
                    }
                ]
            });

            assert.strictEqual(items.length, 0);
        }
    );

    await runTest(
        'TEST 7: UNKNOWN inventory behavior unchanged for closure candidates',
        async () => {
            const items = collectDestinationInventoryItems({
                closureCandidates: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Membership_Plan__c.Sessions_Limit__c'
                    }
                ]
            });

            const inventoryResult = await buildDestinationInventory({
                items,
                accessToken: null,
                instanceUrl: null
            });

            const destinationStates = toDestinationStateMap(
                inventoryResult.inventory
            );

            assert.strictEqual(items.length, 1);
            assert.strictEqual(
                destinationStates.get(
                    'CustomField:Membership_Plan__c.Sessions_Limit__c'
                ),
                'UNKNOWN'
            );
            assert.strictEqual(inventoryResult.summary.requested, 1);
        }
    );
}

main().then(() => {
    if (process.exitCode) {
        console.error('destinationInventoryCandidateCollector.service tests FAILED');
    } else {
        console.log('destinationInventoryCandidateCollector.service tests PASSED');
    }
});
