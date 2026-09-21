'use strict';

const assert = require('assert');

const { buildPicklistsFromUiApi } = require('./recordTypeSemanticDestination.service');

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

runTest('API-only destination fields do not appear when not in capture spec', () => {
    const uiMap = {
        Customer_Field__c: {
            defaultValue: null,
            controllerValues: {},
            values: [{ label: 'Event', value: 'Event', validFor: [] }]
        },
        ForecastCategory: {
            defaultValue: null,
            controllerValues: {},
            values: [{ label: 'Pipeline', value: 'Pipeline', validFor: [] }]
        },
        StageName: {
            defaultValue: null,
            controllerValues: {},
            values: [{ label: 'Prospecting', value: 'Prospecting', validFor: [] }]
        }
    };

    const picklists = buildPicklistsFromUiApi(uiMap, ['Customer_Field__c']);

    assert.strictEqual(picklists.length, 1);
    assert.strictEqual(picklists[0].fieldApiName, 'Customer_Field__c');
});

runTest('missing expected picklist field throws', () => {
    const uiMap = {
        Customer_Field__c: {
            defaultValue: null,
            controllerValues: {},
            values: [{ label: 'Event', value: 'Event', validFor: [] }]
        }
    };

    assert.throws(() => {
        buildPicklistsFromUiApi(uiMap, ['Customer_Field__c', 'Customer_Status__c']);
    }, /Customer_Status__c/);
});
