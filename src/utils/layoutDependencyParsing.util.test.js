const assert = require('assert');

const {
    parseCustomRelatedListReference,
    parseRelatedListDisplayField,
    parseLayoutCustomButtonReference,
    parseLayoutQuickActionReference,
    isStandardRelatedObjectToken
} = require('./layoutDependencyParsing.util');

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

runTest('parseCustomRelatedListReference handles production related lists', () => {
    assert.strictEqual(
        parseCustomRelatedListReference('Lead.Converted_Account__c'),
        'Lead.Converted_Account__c'
    );
    assert.strictEqual(
        parseCustomRelatedListReference('Gym_Trainer__c.Gym_Member__c'),
        'Gym_Trainer__c.Gym_Member__c'
    );
    assert.strictEqual(
        parseCustomRelatedListReference('Payment__c.Account__c'),
        'Payment__c.Account__c'
    );
});

runTest('parseCustomRelatedListReference ignores standard related lists', () => {
    assert.strictEqual(
        parseCustomRelatedListReference('RelatedContactList'),
        null
    );
});

runTest('parseRelatedListDisplayField ignores standard tokens', () => {
    assert.strictEqual(parseRelatedListDisplayField('FULL_NAME'), null);
    assert.strictEqual(parseRelatedListDisplayField('NAME'), null);
    assert.strictEqual(parseRelatedListDisplayField('LEAD.COMPANY'), null);
    assert.strictEqual(parseRelatedListDisplayField('LEAD.PHONE'), null);
});

runTest('parseLayoutCustomButtonReference builds WebLink member names', () => {
    assert.strictEqual(
        parseLayoutCustomButtonReference('Send_Invoice__c', 'Account'),
        'Account.Send_Invoice__c'
    );
    assert.strictEqual(
        parseLayoutCustomButtonReference('Submit', 'Account'),
        null
    );
});

runTest('parseLayoutQuickActionReference filters standard actions', () => {
    assert.strictEqual(
        parseLayoutQuickActionReference('Account.Custom_Action__c'),
        'Account.Custom_Action__c'
    );
    assert.strictEqual(parseLayoutQuickActionReference('Edit'), null);
});

runTest('isStandardRelatedObjectToken recognizes ParentId', () => {
    assert.strictEqual(isStandardRelatedObjectToken('ParentId'), true);
    assert.strictEqual(isStandardRelatedObjectToken('Custom__c'), false);
});
