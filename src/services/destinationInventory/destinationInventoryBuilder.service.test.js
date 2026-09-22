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
        'CustomPermission REST query → EXISTS when a row is returned',
        async () => {
            const stub = stubSalesforce({
                totalSize: 1,
                records: [{ Id: '0Cp000000000001AAA' }]
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomPermission',
                            metadataName: 'MyPermission'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomPermission',
                        'MyPermission'
                    ),
                    DESTINATION_STATE.EXISTS
                );
                assert.ok(
                    stub.requestedUrls.some(
                        (url) =>
                            url.includes('/query') &&
                            !url.includes('/tooling/query')
                    )
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        decodeURIComponent(url).includes(
                            'SELECT Id FROM CustomPermission WHERE DeveloperName ='
                        )
                    )
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        decodeURIComponent(url).includes(
                            'NamespacePrefix = null'
                        )
                    )
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomPermission namespaced REST query → EXISTS',
        async () => {
            const stub = stubSalesforce({
                totalSize: 1,
                records: [{ Id: '0Cp000000000002AAA' }]
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomPermission',
                            metadataName: 'Namespace__MyPermission'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomPermission',
                        'Namespace__MyPermission'
                    ),
                    DESTINATION_STATE.EXISTS
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        decodeURIComponent(url).includes(
                            "DeveloperName = 'MyPermission'"
                        )
                    )
                );
                assert.ok(
                    stub.requestedUrls.some((url) =>
                        decodeURIComponent(url).includes(
                            "NamespacePrefix = 'Namespace'"
                        )
                    )
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomPermission REST query → MISSING when zero rows returned',
        async () => {
            const stub = stubSalesforce({ totalSize: 0, records: [] });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomPermission',
                            metadataName: 'Missing_Permission'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomPermission',
                        'Missing_Permission'
                    ),
                    DESTINATION_STATE.MISSING
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomPermission REST query → UNKNOWN when the query fails',
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
                            metadataType: 'CustomPermission',
                            metadataName: 'MyPermission'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomPermission',
                        'MyPermission'
                    ),
                    DESTINATION_STATE.UNKNOWN
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomPermission unsafe name → UNKNOWN without querying',
        async () => {
            const stub = stubSalesforce({ totalSize: 0, records: [] });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomPermission',
                            metadataName: 'Bad Permission'
                        }
                    ],
                    accessToken: 'test-access-token',
                    instanceUrl: 'https://test.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(
                        result.inventory,
                        'CustomPermission',
                        'Bad Permission'
                    ),
                    DESTINATION_STATE.UNKNOWN
                );
                assert.strictEqual(stub.requestedUrls.length, 0);
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
                'businessProcessRollback.p0r.test.js',
                'compactLayoutRollback.p0r.test.js',
                'customMetadataRollback.p0r.test.js',
                'deleteRollback.p0r82.test.js',
                'deploymentValidation.service.js',
                'destinationSnapshotCapture.service.js',
                'destinationSnapshotCapture.service.test.js',
                'destinationSnapshotMapper.service.js',
                'destinationSnapshotMapper.service.test.js',
                'destinationSnapshotRestore.service.js',
                'externalCredentialRollback.p0r.test.js',
                'flowDestinationValidation.service.js',
                'flowRollback.p0r.test.js',
                'mixedRollback.p0r9.test.js',
                'namedCredentialRollback.p0r.test.js',
                'orgLock.concurrency.p0r58.test.js',
                'orgLock.integration.p0r57.test.js',
                'standardValueSetRollback.p0r.test.js'
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

    function stubCustomMetadataInventory({
        entityTotalSize,
        recordTotalSize,
        failOnEntity = false,
        failOnRecord = false
    }) {
        const originalGet = axios.get;
        const requestedUrls = [];

        axios.get = async (url) => {
            if (url.endsWith('/services/data/')) {
                return { status: 200, data: API_VERSIONS };
            }

            requestedUrls.push(url);

            if (failOnEntity && decodeURIComponent(url).includes('EntityDefinition')) {
                throw new Error('Simulated EntityDefinition query failure');
            }

            if (failOnRecord && decodeURIComponent(url).includes('Weather_Config__mdt')) {
                throw new Error('Simulated CustomMetadata record query failure');
            }

            if (decodeURIComponent(url).includes('EntityDefinition')) {
                return {
                    status: 200,
                    data: {
                        totalSize: entityTotalSize,
                        done: true,
                        records:
                            entityTotalSize > 0
                                ? [{ QualifiedApiName: 'Weather_Config__mdt' }]
                                : []
                    }
                };
            }

            if (decodeURIComponent(url).includes('Weather_Config__mdt')) {
                return {
                    status: 200,
                    data: {
                        totalSize: recordTotalSize,
                        done: true,
                        records: recordTotalSize > 0 ? [{ Id: '0' }] : []
                    }
                };
            }

            throw new Error(`Unexpected inventory query: ${url}`);
        };

        return {
            requestedUrls,
            restore() {
                axios.get = originalGet;
            }
        };
    }

    await runTest(
        'CustomMetadata:Weather_Config.Default EntityDefinition zero → MISSING',
        async () => {
            const stub = stubCustomMetadataInventory({
                entityTotalSize: 0,
                recordTotalSize: 0
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomMetadata',
                            metadataName: 'Weather_Config.Default'
                        }
                    ],
                    accessToken: 'token',
                    instanceUrl: 'https://example.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(result.inventory, 'CustomMetadata', 'Weather_Config.Default'),
                    DESTINATION_STATE.MISSING
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomMetadata:Weather_Config.Default type exists record missing → MISSING',
        async () => {
            const stub = stubCustomMetadataInventory({
                entityTotalSize: 1,
                recordTotalSize: 0
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomMetadata',
                            metadataName: 'Weather_Config.Default'
                        }
                    ],
                    accessToken: 'token',
                    instanceUrl: 'https://example.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(result.inventory, 'CustomMetadata', 'Weather_Config.Default'),
                    DESTINATION_STATE.MISSING
                );
            } finally {
                stub.restore();
            }
        }
    );

    await runTest(
        'CustomMetadata:Weather_Config.Default type and record present → EXISTS',
        async () => {
            const stub = stubCustomMetadataInventory({
                entityTotalSize: 1,
                recordTotalSize: 1
            });

            try {
                const result = await buildDestinationInventory({
                    items: [
                        {
                            metadataType: 'CustomMetadata',
                            metadataName: 'Weather_Config.Default'
                        }
                    ],
                    accessToken: 'token',
                    instanceUrl: 'https://example.my.salesforce.com'
                });

                assert.strictEqual(
                    getState(result.inventory, 'CustomMetadata', 'Weather_Config.Default'),
                    DESTINATION_STATE.EXISTS
                );
            } finally {
                stub.restore();
            }
        }
    );

    function stubFlowDefinitionInventory({ totalSize, fail = false }) {
        const originalGet = axios.get;
        const requestedUrls = [];

        axios.get = async (url) => {
            if (url.endsWith('/services/data/')) {
                return { status: 200, data: API_VERSIONS };
            }

            requestedUrls.push(url);

            if (fail) {
                throw new Error('Simulated FlowDefinition query failure');
            }

            return {
                status: 200,
                data: {
                    totalSize,
                    done: true,
                    records: totalSize > 0 ? [{ Id: '300000000000001' }] : []
                }
            };
        };

        return {
            requestedUrls,
            restore() {
                axios.get = originalGet;
            }
        };
    }

    await runTest('Flow:My_Flow FlowDefinition zero rows → MISSING', async () => {
        const stub = stubFlowDefinitionInventory({ totalSize: 0 });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'My_Flow'
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                getState(result.inventory, 'Flow', 'My_Flow'),
                DESTINATION_STATE.MISSING
            );
            assert.ok(
                stub.requestedUrls.some((url) => url.includes('/tooling/query'))
            );
            assert.ok(
                stub.requestedUrls.some((url) =>
                    decodeURIComponent(url).includes('FROM FlowDefinition')
                )
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('Flow:My_Flow FlowDefinition one row → EXISTS', async () => {
        const stub = stubFlowDefinitionInventory({ totalSize: 1 });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'My_Flow'
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                getState(result.inventory, 'Flow', 'My_Flow'),
                DESTINATION_STATE.EXISTS
            );
        } finally {
            stub.restore();
        }
    });

    await runTest('Flow:My_Flow FlowDefinition query error → UNKNOWN', async () => {
        const stub = stubFlowDefinitionInventory({ totalSize: 0, fail: true });

        try {
            const result = await buildDestinationInventory({
                items: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'My_Flow'
                    }
                ],
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(
                getState(result.inventory, 'Flow', 'My_Flow'),
                DESTINATION_STATE.UNKNOWN
            );
        } finally {
            stub.restore();
        }
    });

    if (!process.exitCode) {
        console.log('destinationInventoryBuilder.service tests passed');
    }
}

main();
