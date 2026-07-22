const assert = require('assert');

const {
    DESTINATION_STATE,
    buildDestinationInventory,
    getState,
    toDestinationStateMap
} = require('./destinationInventoryBuilder.service');

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

    await runTest('service is not required by runtime modules', async () => {
        const fs = require('fs');
        const path = require('path');
        const root = path.join(__dirname, '..');
        const needle =
            "destinationInventory/destinationInventoryBuilder.service";

        function walk(dir, files = []) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

        const consumers = walk(root).filter((file) => {
            if (file.includes('destinationInventoryBuilder.service')) {
                return false;
            }

            if (file.includes('destinationInventoryBuilder.service.test')) {
                return false;
            }

            const content = fs.readFileSync(file, 'utf8');
            return content.includes(needle);
        });

        assert.deepStrictEqual(consumers, []);
    });

    if (!process.exitCode) {
        console.log('destinationInventoryBuilder.service tests passed');
    }
}

main();
