const assert = require('assert');

const {
    collectFlexiPageRelatedListParentObjects,
    parentHasRelatedListRelationship
} = require('./flexiPageParentObjectRelationshipIndex.service');

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
    await runTest('collectFlexiPageRelatedListParentObjects dedupes parents', () => {
        const parents = collectFlexiPageRelatedListParentObjects([
            {
                referenceType: 'FlexiPageDynamicRelatedList',
                sobjectType: 'Member__c'
            },
            {
                referenceType: 'FlexiPageDynamicRelatedList',
                sobjectType: 'Member__c'
            },
            {
                referenceType: 'FlexiPageDynamicRelatedList',
                sobjectType: 'Account'
            },
            {
                referenceType: 'RelatedList',
                sobjectType: 'Member__c'
            }
        ]);

        assert.deepStrictEqual(parents, ['Account', 'Member__c']);
    });

    await runTest('parentHasRelatedListRelationship uses relationshipName contract', () => {
        const childRelationships = [
            { relationshipName: 'Subscriptions', childSObject: 'Subscription__c' }
        ];

        assert.strictEqual(
            parentHasRelatedListRelationship(
                childRelationships,
                'Subscriptions__r'
            ),
            true
        );
        assert.strictEqual(
            parentHasRelatedListRelationship(childRelationships, 'Sessions__r'),
            false
        );
    });

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main();
