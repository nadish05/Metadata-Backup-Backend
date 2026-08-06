const assert = require('assert');
const axios = require('axios');

const {
    buildRecordTypeSoql,
    buildExistenceQuery,
    usesToolingApi
} = require('./destinationExistenceQueries');
const {
    buildDestinationInventory,
    DESTINATION_STATE
} = require('./destinationInventoryBuilder.service');

const PERSON_ACCOUNT_ITEM = {
    metadataType: 'RecordType',
    metadataName: 'PersonAccount.PersonAccount'
};

const API_VERSIONS = [{ version: '64.0' }, { version: '65.0' }];

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

/**
 * Stub the destination HTTP layer. Records every query URL so tests can assert
 * what was actually sent to Salesforce.
 */
function stubSalesforce({ totalSize, records = [] }) {
    const originalGet = axios.get;
    const requestedUrls = [];

    axios.get = async (url) => {
        if (url.endsWith('/services/data/')) {
            return { status: 200, data: API_VERSIONS };
        }

        requestedUrls.push(url);

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

async function buildPersonAccountInventory(stub) {
    const result = await buildDestinationInventory({
        items: [PERSON_ACCOUNT_ITEM],
        accessToken: 'test-access-token',
        instanceUrl: 'https://test.my.salesforce.com'
    });

    return result.inventory.get(
        `${PERSON_ACCOUNT_ITEM.metadataType}:${PERSON_ACCOUNT_ITEM.metadataName}`
    );
}

async function main() {
    await runTest(
        'PersonAccount existence query never references the feature-gated IsPersonType field',
        () => {
            const soql = buildRecordTypeSoql('PersonAccount.PersonAccount');

            assert.strictEqual(soql.includes('IsPersonType'), false);
            assert.ok(soql.includes("DeveloperName = 'PersonAccount'"));
            assert.ok(soql.includes("SobjectType = 'Account'"));
            assert.strictEqual(
                soql,
                buildExistenceQuery('RecordType', 'PersonAccount.PersonAccount')
            );
            assert.strictEqual(usesToolingApi('RecordType'), false);
        }
    );

    await runTest(
        'existing Person Account RecordType resolves to EXISTS',
        async () => {
            const stub = stubSalesforce({
                totalSize: 1,
                records: [
                    {
                        Id: '0125j000000ABCDAA2',
                        DeveloperName: 'PersonAccount',
                        SobjectType: 'Account'
                    }
                ]
            });

            try {
                const entry = await buildPersonAccountInventory(stub);

                assert.strictEqual(entry.state, DESTINATION_STATE.EXISTS);
                assert.strictEqual(entry.queried, true);
                assert.strictEqual(entry.warning, null);
                assert.strictEqual(entry.unsupported, false);
                assert.strictEqual(
                    stub.requestedUrls.some((url) =>
                        url.includes('IsPersonType')
                    ),
                    false
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'org without Person Accounts resolves to MISSING rather than UNKNOWN',
        async () => {
            const stub = stubSalesforce({ totalSize: 0, records: [] });

            try {
                const entry = await buildPersonAccountInventory(stub);

                assert.strictEqual(entry.state, DESTINATION_STATE.MISSING);
                assert.notStrictEqual(entry.state, DESTINATION_STATE.UNKNOWN);
                assert.strictEqual(entry.queried, true);
                assert.strictEqual(entry.warning, null);
            } finally {
                stub.restore();
            }
        }
    );

    await runTest('standard RecordType queries are unchanged', () => {
        assert.strictEqual(
            buildRecordTypeSoql('Member__c.Standard'),
            "SELECT Id, DeveloperName, SobjectType FROM RecordType WHERE DeveloperName = 'Standard' AND SobjectType = 'Member__c' LIMIT 1"
        );
        assert.strictEqual(
            buildRecordTypeSoql('Account.Customer'),
            "SELECT Id, DeveloperName, SobjectType FROM RecordType WHERE DeveloperName = 'Customer' AND SobjectType = 'Account' LIMIT 1"
        );
        assert.strictEqual(buildRecordTypeSoql('NoSeparator'), null);
    });

    if (!process.exitCode) {
        console.log(
            'destinationInventoryBuilder.service PersonAccount tests passed'
        );
    }
}

main();
