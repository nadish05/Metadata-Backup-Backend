'use strict';

const assert = require('assert');
const axios = require('axios');

const {
    buildExistenceQuery,
    buildValidationRuleSoql,
    usesToolingApi
} = require('./destinationExistenceQueries');
const {
    DESTINATION_STATE,
    buildDestinationInventory
} = require('./destinationInventoryBuilder.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

const API_VERSIONS = [{ version: '64.0' }];

function stubToolingQuery({ totalSize, records = [], fail = false }) {
    const originalGet = axios.get;
    const requestedUrls = [];

    axios.get = async (url) => {
        if (url.endsWith('/services/data/')) {
            return { status: 200, data: API_VERSIONS };
        }

        requestedUrls.push(url);

        if (fail) {
            throw new Error('Simulated ValidationRule query failure');
        }

        return {
            status: 200,
            data: { totalSize, done: true, records }
        };
    };

    return {
        requestedUrls,
        restore() {
            axios.get = originalGet;
        }
    };
}

(async () => {
    await runTest('buildValidationRuleSoql targets object and rule names', () => {
        const soql = buildValidationRuleSoql('Vehicle__c.Require_Model');

        assert.ok(soql.includes("ValidationName = 'Require_Model'"));
        assert.ok(soql.includes("EntityDefinition.QualifiedApiName = 'Vehicle__c'"));
        assert.ok(soql.includes('FROM ValidationRule'));
    });

    await runTest('buildValidationRuleSoql returns null for unqualified names', () => {
        assert.strictEqual(buildValidationRuleSoql('Require_Model'), null);
        assert.strictEqual(buildValidationRuleSoql(''), null);
    });

    await runTest('buildExistenceQuery wires ValidationRule to Tooling SOQL', () => {
        assert.strictEqual(usesToolingApi('ValidationRule'), true);
        const soql = buildExistenceQuery(
            'ValidationRule',
            'Account.Require_Model'
        );

        assert.ok(soql.includes("EntityDefinition.QualifiedApiName = 'Account'"));
        assert.ok(soql.includes("ValidationName = 'Require_Model'"));
    });

    await runTest('inventory reports EXISTS when ValidationRule query returns rows', async () => {
        const stub = stubToolingQuery({ totalSize: 1, records: [{ Id: '0' }] });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'ValidationRule',
                        metadataName: 'Vehicle__c.Require_Model'
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get('ValidationRule:Vehicle__c.Require_Model').state,
                DESTINATION_STATE.EXISTS
            );
            assert.ok(
                stub.requestedUrls.some((url) => url.includes('/tooling/query'))
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('inventory reports MISSING when ValidationRule query is empty', async () => {
        const stub = stubToolingQuery({ totalSize: 0, records: [] });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'ValidationRule',
                        metadataName: 'Vehicle__c.Require_Model'
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get('ValidationRule:Vehicle__c.Require_Model').state,
                DESTINATION_STATE.MISSING
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('inventory reports UNKNOWN when ValidationRule query fails', async () => {
        const stub = stubToolingQuery({ fail: true });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'ValidationRule',
                        metadataName: 'Vehicle__c.Require_Model'
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                result.inventory.get('ValidationRule:Vehicle__c.Require_Model').state,
                DESTINATION_STATE.UNKNOWN
            );
        } finally {
            stub.restore();
        }
    });
})();
