const assert = require('assert');

const {
    extractStructuralActionOverrideFieldApiNames,
    parseRecordFieldApiName
} = require('./structuralActionOverrideField.discoverer');

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
    await runTest('parses fieldItem Record references', () => {
        assert.strictEqual(
            parseRecordFieldApiName('Record.Remaining_Sessions__c'),
            'Remaining_Sessions__c'
        );
    });

    await runTest('parses formula expression references', () => {
        assert.strictEqual(
            parseRecordFieldApiName('{!Record.Remaining_Sessions__c}'),
            'Remaining_Sessions__c'
        );
    });

    await runTest('skips relationship path fields', () => {
        assert.strictEqual(
            parseRecordFieldApiName('Record.Account__r.Name'),
            null
        );
    });

    await runTest('dedupes fieldItem and expression references', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldItem>Record.Remaining_Sessions__c</fieldItem>
    <value>{!Record.Remaining_Sessions__c}</value>
</FlexiPage>`;

        assert.deepStrictEqual(
            extractStructuralActionOverrideFieldApiNames(xml),
            ['Remaining_Sessions__c']
        );
    });

    if (process.exitCode) {
        console.error('structuralActionOverrideField.discoverer.test.js FAILED');
    } else {
        console.log('structuralActionOverrideField.discoverer.test.js PASSED');
    }
}

main();
