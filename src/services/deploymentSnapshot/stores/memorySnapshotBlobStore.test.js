const assert = require('assert');

const {
    BLOB_STORE_METHODS,
    assertBlobStore
} = require('./snapshotBlobStore');
const {
    createMemorySnapshotBlobStore
} = require('./memorySnapshotBlobStore');

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
    await runTest('memory blob store implements the contract', () => {
        const store = createMemorySnapshotBlobStore();
        assertBlobStore(store);
        BLOB_STORE_METHODS.forEach((method) => {
            assert.strictEqual(typeof store[method], 'function');
        });
    });

    await runTest('put / get / exists / getMetadata round-trip exact bytes', async () => {
        const store = createMemorySnapshotBlobStore();
        const bytes = Buffer.from('destination-before-xml');

        const put = await store.putArtifact({
            artifactId: 'art-1',
            bytes
        });

        assert.strictEqual(put.size, bytes.length);
        assert.strictEqual(await store.exists('art-1'), true);

        const got = await store.getArtifact('art-1');
        assert.strictEqual(got.equals(bytes), true);

        const meta = await store.getMetadata('art-1');
        assert.strictEqual(meta.size, bytes.length);

        got.write('x');
        const gotAgain = await store.getArtifact('art-1');
        assert.strictEqual(gotAgain.equals(bytes), true);
    });

    await runTest('missing artifact returns null / false', async () => {
        const store = createMemorySnapshotBlobStore();

        assert.strictEqual(await store.getArtifact('missing'), null);
        assert.strictEqual(await store.exists('missing'), false);
        assert.strictEqual(await store.getMetadata('missing'), null);
    });
}

main();
