const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');

const {
    SNAPSHOT_RELATIVE_PATH,
    buildRetrievalSnapshotMetadata,
    writeRetrievalSnapshotMetadata,
    persistRetrievalSnapshotMetadata
} = require('./retrievalSnapshotMetadata.service');

const mkdtemp = util.promisify(fs.mkdtemp);
const readFile = util.promisify(fs.readFile);
const rm = util.promisify(fs.rm);
const execFileAsync = util.promisify(execFile);

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

async function withTemporaryProject(fn) {
    const projectPath = await mkdtemp(
        path.join(os.tmpdir(), 'retrieval-snapshot-')
    );

    try {
        return await fn(projectPath);
    } finally {
        await rm(projectPath, { recursive: true, force: true });
    }
}

async function main() {
    await runTest('Successful metadata creation', () => {
        const metadata = buildRetrievalSnapshotMetadata({
            sourceOrgId: '00D000000000001',
            instanceUrl: 'https://source.my.salesforce.com',
            sourceMetadataApiVersion: '66.0',
            retrievedAt: '2026-08-06T08:35:22Z'
        });

        assert.deepStrictEqual(metadata, {
            snapshotVersion: 1,
            sourceOrgId: '00D000000000001',
            sourceMetadataApiVersion: '66.0',
            retrievedAt: '2026-08-06T08:35:22Z'
        });
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(metadata, 'instanceUrl'),
            false
        );
    });

    await runTest('Null Metadata API version', () => {
        const metadata = buildRetrievalSnapshotMetadata({
            sourceOrgId: '00D000000000001',
            sourceMetadataApiVersion: null,
            retrievedAt: '2026-08-06T08:35:22Z'
        });

        assert.strictEqual(metadata.sourceMetadataApiVersion, null);
    });

    await runTest('Directory creation', () =>
        withTemporaryProject(async (projectPath) => {
            const metadata = buildRetrievalSnapshotMetadata({
                sourceOrgId: '00D000000000001',
                sourceMetadataApiVersion: '66.0',
                retrievedAt: '2026-08-06T08:35:22Z'
            });
            const snapshotPath = await writeRetrievalSnapshotMetadata(
                projectPath,
                metadata
            );
            const written = JSON.parse(await readFile(snapshotPath, 'utf8'));

            assert.strictEqual(
                snapshotPath,
                path.join(projectPath, SNAPSHOT_RELATIVE_PATH)
            );
            assert.deepStrictEqual(written, metadata);
        })
    );

    await runTest('Overwrite existing snapshot', () =>
        withTemporaryProject(async (projectPath) => {
            await writeRetrievalSnapshotMetadata(
                projectPath,
                buildRetrievalSnapshotMetadata({
                    sourceMetadataApiVersion: '64.0',
                    retrievedAt: '2026-08-06T08:00:00Z'
                })
            );
            const replacement = buildRetrievalSnapshotMetadata({
                sourceMetadataApiVersion: '66.0',
                retrievedAt: '2026-08-06T08:35:22Z'
            });

            const snapshotPath = await writeRetrievalSnapshotMetadata(
                projectPath,
                replacement
            );
            const written = JSON.parse(await readFile(snapshotPath, 'utf8'));

            assert.deepStrictEqual(written, replacement);
        })
    );

    await runTest('Git migration naturally includes snapshot', () =>
        withTemporaryProject(async (projectPath) => {
            await writeRetrievalSnapshotMetadata(
                projectPath,
                buildRetrievalSnapshotMetadata({
                    sourceMetadataApiVersion: '66.0',
                    retrievedAt: '2026-08-06T08:35:22Z'
                })
            );

            await execFileAsync('git', ['init'], { cwd: projectPath });
            await execFileAsync('git', ['add', '.'], { cwd: projectPath });
            const tracked = await execFileAsync(
                'git',
                ['ls-files', '--cached'],
                { cwd: projectPath }
            );

            assert.ok(
                tracked.stdout
                    .replace(/\\/g, '/')
                    .includes(
                        '.metadata-backup/retrieval-metadata.json'
                    )
            );
        })
    );

    await runTest('Discovery failure does not fail retrieval snapshot', () =>
        withTemporaryProject(async (projectPath) => {
            const result = await persistRetrievalSnapshotMetadata({
                projectPath,
                sourceOrgId: '00D000000000001',
                instanceUrl: 'https://source.my.salesforce.com',
                accessToken: 'not-persisted',
                retrievedAt: '2026-08-06T08:35:22Z',
                getLatestApiVersionFn: async () => {
                    throw new Error('Salesforce unavailable');
                }
            });
            const written = JSON.parse(
                await readFile(result.snapshotPath, 'utf8')
            );

            assert.strictEqual(result.written, true);
            assert.strictEqual(
                result.snapshotMetadata.sourceMetadataApiVersion,
                null
            );
            assert.strictEqual(
                written.sourceMetadataApiVersion,
                null
            );
        })
    );
}

main();
