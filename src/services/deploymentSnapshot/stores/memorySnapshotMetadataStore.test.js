const assert = require('assert');

const {
    SNAPSHOT_STATUS
} = require('../snapshot.types');
const {
    SnapshotAlreadySealedError,
    SnapshotNotFoundError
} = require('../snapshot.errors');
const {
    METADATA_STORE_METHODS,
    assertMetadataStore
} = require('./snapshotMetadataStore');
const {
    createMemorySnapshotMetadataStore
} = require('./memorySnapshotMetadataStore');

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

async function main() {
    await runTest('memory metadata store implements the contract', () => {
        const store = createMemorySnapshotMetadataStore();
        assertMetadataStore(store);
        METADATA_STORE_METHODS.forEach((method) => {
            assert.strictEqual(typeof store[method], 'function');
        });
    });

    await runTest('create / get / addMember / getMembers', async () => {
        const store = createMemorySnapshotMetadataStore();
        const created = await store.createSnapshot({
            snapshotId: 'snapshot_test_1',
            status: SNAPSHOT_STATUS.CAPTURING,
            destinationOrgId: '00Dxxx'
        });

        assert.strictEqual(created.snapshotId, 'snapshot_test_1');

        await store.addMember({
            snapshotId: 'snapshot_test_1',
            metadataType: 'ApexClass',
            metadataName: 'Foo'
        });

        const members = await store.getMembers('snapshot_test_1');
        assert.strictEqual(members.length, 1);
        assert.strictEqual(members[0].metadataName, 'Foo');
    });

    await runTest('sealed snapshots reject metadata mutation', async () => {
        const store = createMemorySnapshotMetadataStore();
        await store.createSnapshot({
            snapshotId: 'snapshot_test_2',
            status: SNAPSHOT_STATUS.READY
        });
        await store.sealSnapshot('snapshot_test_2', { sealedAt: 'now' });

        await assert.rejects(
            () =>
                store.updateSnapshot('snapshot_test_2', {
                    status: SNAPSHOT_STATUS.CAPTURING
                }),
            SnapshotAlreadySealedError
        );
        await assert.rejects(
            () =>
                store.addMember({
                    snapshotId: 'snapshot_test_2',
                    metadataType: 'ApexClass',
                    metadataName: 'Bar'
                }),
            SnapshotAlreadySealedError
        );
    });

    await runTest('missing snapshot throws SnapshotNotFoundError', async () => {
        const store = createMemorySnapshotMetadataStore();

        await assert.rejects(
            () => store.getMembers('missing'),
            SnapshotNotFoundError
        );
    });
}

main();
