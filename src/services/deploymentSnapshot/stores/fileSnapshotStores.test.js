'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SNAPSHOT_STATUS, CHANGE_CLASS } = require('../snapshot.types');
const {
    SnapshotAlreadySealedError,
    SnapshotMemberConflictError,
    SnapshotStateError
} = require('../snapshot.errors');
const {
    METADATA_STORE_METHODS,
    assertMetadataStore
} = require('./snapshotMetadataStore');
const {
    BLOB_STORE_METHODS,
    assertBlobStore
} = require('./snapshotBlobStore');
const { createFileSnapshotStores } = require('./fileSnapshotStores');
const { createSnapshotCaptureService } = require('../snapshotCapture.service');
const { hashBytes } = require('../snapshotIntegrity.service');

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

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'p0r52-file-store-'));
}

(async () => {
    await runTest('file stores implement metadata and blob contracts', () => {
        const { metadataStore, blobStore } = createFileSnapshotStores({
            rootDir: tempRoot()
        });

        assertMetadataStore(metadataStore);
        assertBlobStore(blobStore);
        METADATA_STORE_METHODS.forEach((method) => {
            assert.strictEqual(typeof metadataStore[method], 'function');
        });
        BLOB_STORE_METHODS.forEach((method) => {
            assert.strictEqual(typeof blobStore[method], 'function');
        });
    });

    await runTest('create / get / update / add / seal persist across store instances', async () => {
        const root = tempRoot();
        const first = createFileSnapshotStores({ rootDir: root });
        const created = await first.metadataStore.createSnapshot({
            snapshotId: 'snapshot_persist_1',
            status: SNAPSHOT_STATUS.CAPTURING,
            destinationOrgId: '00Dxxx',
            schemaVersion: 2
        });

        await first.metadataStore.updateSnapshot('snapshot_persist_1', {
            memberCount: 1
        });
        await first.metadataStore.addMember({
            snapshotId: 'snapshot_persist_1',
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeHash: 'aaa',
            expectedAfterHash: 'bbb',
            artifactId: 'snapshots/snapshot_persist_1/destination-before/ApexClass/AccountService',
            existedBefore: true,
            captureStatus: 'COMPLETE'
        });

        const bytes = Buffer.from('public class AccountService {\r\n}\n');
        await first.blobStore.putArtifact({
            artifactId:
                'snapshots/snapshot_persist_1/destination-before/ApexClass/AccountService',
            bytes
        });

        await first.metadataStore.sealSnapshot('snapshot_persist_1', {
            sealedAt: 'now',
            rollbackEligible: false
        });

        const second = createFileSnapshotStores({ rootDir: root });
        const loaded = await second.metadataStore.getSnapshot(
            'snapshot_persist_1'
        );
        const member = await second.metadataStore.getMember(
            'snapshot_persist_1',
            'ApexClass',
            'AccountService'
        );
        const members = await second.metadataStore.getMembers(
            'snapshot_persist_1'
        );
        const stored = await second.blobStore.getArtifact(
            'snapshots/snapshot_persist_1/destination-before/ApexClass/AccountService'
        );

        assert.strictEqual(created.snapshotId, 'snapshot_persist_1');
        assert.strictEqual(loaded.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(loaded.memberCount, 1);
        assert.strictEqual(member.expectedAfterHash, 'bbb');
        assert.strictEqual(members.length, 1);
        assert.ok(stored.equals(bytes));
        assert.strictEqual(hashBytes(stored), hashBytes(bytes));
        assert.strictEqual(loaded.rollbackEligible, false);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('sealed snapshots reject metadata and artifact mutation', async () => {
        const root = tempRoot();
        const { metadataStore, blobStore } = createFileSnapshotStores({
            rootDir: root
        });

        await metadataStore.createSnapshot({
            snapshotId: 'snapshot_seal_1',
            status: SNAPSHOT_STATUS.READY
        });
        await blobStore.putArtifact({
            artifactId: 'snapshots/snapshot_seal_1/destination-before/ApexClass/A',
            bytes: Buffer.from('before')
        });
        await metadataStore.sealSnapshot('snapshot_seal_1', { sealedAt: 'now' });

        await assert.rejects(
            () =>
                metadataStore.updateSnapshot('snapshot_seal_1', {
                    memberCount: 9
                }),
            SnapshotAlreadySealedError
        );
        await assert.rejects(
            () =>
                metadataStore.addMember({
                    snapshotId: 'snapshot_seal_1',
                    metadataType: 'ApexClass',
                    metadataName: 'B'
                }),
            SnapshotAlreadySealedError
        );
        await assert.rejects(
            () =>
                blobStore.putArtifact({
                    artifactId:
                        'snapshots/snapshot_seal_1/destination-before/ApexClass/B',
                    bytes: Buffer.from('nope')
                }),
            SnapshotAlreadySealedError
        );
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('duplicate snapshot ids and members are rejected', async () => {
        const root = tempRoot();
        const { metadataStore } = createFileSnapshotStores({ rootDir: root });

        await metadataStore.createSnapshot({
            snapshotId: 'snapshot_dup_1',
            status: SNAPSHOT_STATUS.CAPTURING
        });
        await assert.rejects(
            () =>
                metadataStore.createSnapshot({
                    snapshotId: 'snapshot_dup_1',
                    status: SNAPSHOT_STATUS.CAPTURING
                }),
            SnapshotStateError
        );

        await metadataStore.addMember({
            snapshotId: 'snapshot_dup_1',
            metadataType: 'ApexClass',
            metadataName: 'Foo'
        });
        await assert.rejects(
            () =>
                metadataStore.addMember({
                    snapshotId: 'snapshot_dup_1',
                    metadataType: 'ApexClass',
                    metadataName: 'Foo'
                }),
            SnapshotMemberConflictError
        );
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('binary and LF artifacts remain exact', async () => {
        const root = tempRoot();
        const { blobStore } = createFileSnapshotStores({ rootDir: root });
        const binary = Buffer.from([0, 1, 2, 255, 10]);
        const lf = Buffer.from('line1\nline2\n');

        await blobStore.putArtifact({
            artifactId: 'snapshots/snapshot_bin/destination-before/ApexClass/Bin',
            bytes: binary
        });
        await blobStore.putArtifact({
            artifactId: 'snapshots/snapshot_bin/destination-before/ApexClass/Lf',
            bytes: lf
        });

        assert.ok(
            (await blobStore.getArtifact(
                'snapshots/snapshot_bin/destination-before/ApexClass/Bin'
            )).equals(binary)
        );
        assert.ok(
            (await blobStore.getArtifact(
                'snapshots/snapshot_bin/destination-before/ApexClass/Lf'
            )).equals(lf)
        );
        assert.strictEqual(
            await blobStore.exists(
                'snapshots/snapshot_bin/destination-before/ApexClass/Bin'
            ),
            true
        );
        assert.deepStrictEqual(
            await blobStore.getMetadata(
                'snapshots/snapshot_bin/destination-before/ApexClass/Bin'
            ),
            { artifactId: 'snapshots/snapshot_bin/destination-before/ApexClass/Bin', size: 5 }
        );
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('capture through one file-store instance loads from another', async () => {
        const root = tempRoot();
        const writer = createFileSnapshotStores({ rootDir: root });
        const reader = createFileSnapshotStores({ rootDir: root });
        const service = createSnapshotCaptureService(writer);
        const bytes = Buffer.from('dest-before');
        const after = Buffer.from('expected-after');

        const ready = await service.captureSnapshot({
            deploymentContext: { destinationOrgId: '00Dfile' },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'FileStoreProbe',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: bytes,
                    expectedAfterBytes: after
                }
            ]
        });
        const sealed = await service.sealSnapshot(ready.snapshotId);
        const loaded = await reader.metadataStore.getSnapshot(sealed.snapshotId);
        const members = await reader.metadataStore.getMembers(sealed.snapshotId);
        const artifact = await reader.blobStore.getArtifact(members[0].artifactId);

        assert.strictEqual(loaded.status, SNAPSHOT_STATUS.SEALED);
        assert.ok(artifact.equals(bytes));
        assert.strictEqual(loaded.rollbackEligible, true);
        await fs.promises.rm(root, { recursive: true, force: true });
    });
})();
