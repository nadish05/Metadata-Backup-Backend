const assert = require('assert');

const {
    collectSeedNodes,
    toFrontierNode
} = require('./graphExpansion.service');
const {
    METADATA_ORIGINS
} = require('../metadataGraphOrigin.model');

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

async function main() {
    await runTest(
        'TEST 1: toFrontierNode preserves layout ParentObject referenceType and discoveryMethod',
        async () => {
            const node = toFrontierNode({
                metadataType: 'CustomObject',
                metadataName: 'Account',
                name: 'Account',
                referenceType: 'ParentObject',
                relationship: 'ParentObject',
                discoveryMethod: 'layoutReference',
                sourceMetadata: 'Account-Gym Member Layout',
                deployable: true,
                blocking: true,
                depth: 1
            });

            assert.strictEqual(node.referenceType, 'ParentObject');
            assert.strictEqual(node.relationship, 'ParentObject');
            assert.strictEqual(node.discoveryMethod, 'layoutReference');
            assert.strictEqual(node.sourceMetadata, 'Account-Gym Member Layout');
        }
    );

    await runTest(
        'TEST 2: toFrontierNode preserves layout RelatedListParentObject referenceType and discoveryMethod',
        async () => {
            const node = toFrontierNode({
                metadataType: 'CustomObject',
                metadataName: 'Payment__c',
                name: 'Payment__c',
                referenceType: 'RelatedListParentObject',
                relationship: 'RelatedListParentObject',
                discoveryMethod: 'layoutReference',
                sourceMetadata: 'Account-Gym Member Layout',
                deployable: true,
                blocking: true,
                depth: 1
            });

            assert.strictEqual(node.referenceType, 'RelatedListParentObject');
            assert.strictEqual(node.relationship, 'RelatedListParentObject');
            assert.strictEqual(node.discoveryMethod, 'layoutReference');
            assert.strictEqual(node.sourceMetadata, 'Account-Gym Member Layout');
        }
    );

    await runTest(
        'TEST 3: collectSeedNodes preserves layout ingress on CustomObject seeds',
        async () => {
            const seeds = collectSeedNodes({
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: 'Account-Gym Member Layout'
                    }
                ],
                discoveredReferences: [
                    {
                        metadataType: 'CustomObject',
                        name: 'Account',
                        referenceType: 'ParentObject',
                        relationship: 'ParentObject',
                        discoveryMethod: 'layoutReference',
                        deployable: true,
                        blocking: true
                    },
                    {
                        metadataType: 'CustomObject',
                        name: 'Payment__c',
                        referenceType: 'RelatedListParentObject',
                        relationship: 'RelatedListParentObject',
                        discoveryMethod: 'layoutReference',
                        deployable: true,
                        blocking: true
                    }
                ]
            });

            const accountSeed = seeds.find(
                (seed) => seed.metadataType === 'CustomObject' && seed.name === 'Account'
            );
            const paymentSeed = seeds.find(
                (seed) =>
                    seed.metadataType === 'CustomObject' && seed.name === 'Payment__c'
            );

            assert.strictEqual(accountSeed.origin, METADATA_ORIGINS.SECONDARY_DEPENDENCY);
            assert.strictEqual(accountSeed.referenceType, 'ParentObject');
            assert.strictEqual(accountSeed.discoveryMethod, 'layoutReference');
            assert.strictEqual(paymentSeed.referenceType, 'RelatedListParentObject');
            assert.strictEqual(paymentSeed.discoveryMethod, 'layoutReference');
        }
    );
}

main();
