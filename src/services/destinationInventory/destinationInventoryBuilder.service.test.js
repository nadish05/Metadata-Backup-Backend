const assert = require('assert');
const axios = require('axios');

const {
    DESTINATION_STATE,
    buildDestinationInventory,
    getState,
    toDestinationStateMap
} = require('./destinationInventoryBuilder.service');

const API_VERSIONS = [{ version: '64.0' }, { version: '65.0' }];

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function stubSalesforce({ totalSize, records = [], fail = false }) {
    const originalGet = axios.get;
    const requestedUrls = [];

    axios.get = async (url) => {
        if (url.endsWith('/services/data/')) {
            return { status: 200, data: API_VERSIONS };
        }

        requestedUrls.push(url);

        if (fail) {
            throw new Error('Simulated ApexPage query failure');
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

async function main() {
    await runTest('empty items returns empty inventory', async () => {
        const result = await buildDestinationInventory({ items: [] });

        assert.strictEqual(result.inventory.size, 0);
        assert.strictEqual(result.summary.requested, 0);
    });

    await runTest(
        'missing credentials yields UNKNOWN (never MISSING)',
        async () => {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Foo'
                    },
                    {
                        type: 'CustomObject',
                        name: 'Account__c'
                    }
                ]
            });

            assert.strictEqual(result.inventory.size, 2);
            assert.strictEqual(result.summary.unknown, 2);
            assert.strictEqual(result.summary.missing, 0);
            assert.strictEqual(
                getState(result.inventory, 'ApexClass', 'Foo'),
                DESTINATION_STATE.UNKNOWN
            );
            assert.strictEqual(
                getState(result.inventory, 'CustomObject', 'Account__c'),
                DESTINATION_STATE.UNKNOWN
            );
        }
    );

    await runTest('deduplicates Type:Name keys', async () => {
        const result = await buildDestinationInventory({
            items: [
                { metadataType: 'ApexClass', metadataName: 'Foo' },
                { type: 'ApexClass', name: 'Foo' },
                { metadataType: 'ApexClass', metadataName: 'Bar' }
            ]
        });

        assert.strictEqual(result.inventory.size, 2);
    });

    await runTest('toDestinationStateMap preserves states', async () => {
        const inventory = new Map([
            [
                'ApexClass:Foo',
                {
                    metadataType: 'ApexClass',
                    metadataName: 'Foo',
                    state: DESTINATION_STATE.EXISTS
                }
            ],
            [
                'CustomObject:Bar__c',
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Bar__c',
                    state: DESTINATION_STATE.MISSING
                }
            ]
        ]);

        const map = toDestinationStateMap(inventory);

        assert.strictEqual(map.get('ApexClass:Foo'), 'EXISTS');
        assert.strictEqual(map.get('CustomObject:Bar__c'), 'MISSING');
        assert.strictEqual(
            getState(inventory, 'ApexClass', 'Missing'),
            DESTINATION_STATE.UNKNOWN
        );
    });

    await runTest(
        'ApexPage Tooling query → EXISTS when a row is returned',
        async () => {
            const stub = stubSalesforce({
                totalSize: 1,
                records: [{ Id: '066000000000001AAA' }]
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'ApexPage',
                            metadataName: 'Weather_Dashboard'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(result.inventory, 'ApexPage', 'Weather_Dashboard'),
                    DESTINATION_STATE.EXISTS
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        url.includes('/tooling/query')
                    )
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        decodeURIComponent(url).includes(
                            'SELECT Id FROM ApexPage WHERE Name ='
                        )
                    )
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'ApexPage Tooling query → MISSING when zero rows returned',
        async () => {
            const stub = stubSalesforce({ totalSize: 0, records: [] });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'ApexPage',
                            metadataName: 'Missing_Page'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(result.inventory, 'ApexPage', 'Missing_Page'),
                    DESTINATION_STATE.MISSING
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'ApexPage Tooling query → UNKNOWN when the query fails',
        async () => {
            const stub = stubSalesforce({
                totalSize: 0,
                records: [],
                fail: true
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'ApexPage',
                            metadataName: 'Weather_Dashboard'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(result.inventory, 'ApexPage', 'Weather_Dashboard'),
                    DESTINATION_STATE.UNKNOWN
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomApplication Tooling query → EXISTS when a row is returned',
        async () => {
            const stub = stubSalesforce({
                totalSize: 1,
                records: [{ Id: '0Ap000000000001AAA' }]
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomApplication',
                            metadataName: 'My_Custom_App'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomApplication',
                        'My_Custom_App'
                    ),
                    DESTINATION_STATE.EXISTS
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        url.includes('/tooling/query')
                    )
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        decodeURIComponent(url).includes(
                            'SELECT Id FROM CustomApplication WHERE FullName ='
                        )
                    )
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomApplication standard__Sales Tooling query → EXISTS',
        async () => {
            const stub = stubSalesforce({
                totalSize: 1,
                records: [{ Id: '0Ap000000000002AAA' }]
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomApplication',
                            metadataName: 'standard__Sales'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomApplication',
                        'standard__Sales'
                    ),
                    DESTINATION_STATE.EXISTS
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        decodeURIComponent(url).includes(
                            "FullName = 'standard__Sales'"
                        )
                    )
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomApplication Tooling query → MISSING when zero rows returned',
        async () => {
            const stub = stubSalesforce({ totalSize: 0, records: [] });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomApplication',
                            metadataName: 'Missing_App'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomApplication',
                        'Missing_App'
                    ),
                    DESTINATION_STATE.MISSING
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomApplication Tooling query → UNKNOWN when the query fails',
        async () => {
            const stub = stubSalesforce({
                totalSize: 0,
                records: [],
                fail: true
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomApplication',
                            metadataName: 'My_Custom_App'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomApplication',
                        'My_Custom_App'
                    ),
                    DESTINATION_STATE.UNKNOWN
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'only orchestration consumes the builder; no legacy existence helpers remain',
        async () => {
            const fs = require('fs');
            const path = require('path');
            const servicesRoot = path.join(__dirname, '..');
            const needle =
                "destinationInventory/destinationInventoryBuilder.service";

            function walk(dir, files = []) {
                for (const entry of fs.readdirSync(dir, {
                    withFileTypes: true
                })) {
                    if (entry.name === 'node_modules') {
                        continue;
                    }

                    const full = path.join(dir, entry.name);

                    if (entry.isDirectory()) {
                        walk(full, files);
                    } else if (entry.name.endsWith('.js')) {
                        files.push(full);
                    }
                }

                return files;
            }

            const consumers = walk(servicesRoot)
                .filter((file) => {
                    if (file.includes('destinationInventoryBuilder.service')) {
                        return false;
                    }

                    const content = fs.readFileSync(file, 'utf8');
                    return content.includes(needle);
                })
                .map((file) => path.basename(file));

            assert.deepStrictEqual(consumers.sort(), [
                'deploymentValidation.service.js',
                'flowDestinationValidation.service.js'
            ]);

            const resolution = fs.readFileSync(
                path.join(
                    servicesRoot,
                    'dependencyResolution',
                    'dependencyResolution.service.js'
                ),
                'utf8'
            );
            const validation = fs.readFileSync(
                path.join(servicesRoot, 'dependencyValidation.service.js'),
                'utf8'
            );

            assert.strictEqual(
                resolution.includes('buildDestinationStates'),
                false
            );
            assert.strictEqual(
                resolution.includes('queryCustomObjectExists'),
                false
            );
            assert.strictEqual(
                validation.includes('dependencyExistsInDestination'),
                false
            );
            assert.strictEqual(validation.includes('runSoqlQuery'), false);
            assert.strictEqual(
                validation.includes('getLatestApiVersion'),
                false
            );
        }
    );

    if (!process.exitCode) {
        console.log('destinationInventoryBuilder.service tests passed');
    }
}

main();
