'use strict';

const assert = require('assert');

const {
    getSharedSnapshotAccess
} = require('./snapshotAccess.service');
const accessAgain = require('./snapshotAccess.service');
const {
    CHANGE_CLASS,
    SNAPSHOT_STATUS
} = require('./snapshot.types');
const { MEMORY_SNAPSHOT_STORAGE_CAPABILITY } = require('./snapshotStorageCapability');

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

(async () => {
    await runTest('module loads return the same shared snapshot accessor', () => {
        assert.strictEqual(
            getSharedSnapshotAccess(),
            accessAgain.getSharedSnapshotAccess()
        );
        assert.strictEqual(
            getSharedSnapshotAccess().captureService,
            accessAgain.getSharedSnapshotAccess().captureService
        );
    });

    await runTest('memory storage is identified as non-durable', () => {
        const capability = getSharedSnapshotAccess().getStorageCapability();

        assert.deepStrictEqual(capability, {
            ...MEMORY_SNAPSHOT_STORAGE_CAPABILITY
        });
        assert.strictEqual(capability.durable, false);
        assert.strictEqual(capability.processLocal, true);
        assert.strictEqual(capability.shared, false);
        assert.strictEqual(capability.rollbackProductionReady, false);
        assert.strictEqual(capability.storageMode, 'MEMORY');
    });

    await runTest('snapshot captured through accessor can be loaded through accessor', async () => {
        const access = getSharedSnapshotAccess();
        const bytes = Buffer.from('shared-access-dest-before\n');
        const afterBytes = Buffer.from('shared-access-expected-after\n');

        const ready = await access.captureService.captureSnapshot({
            deploymentContext: {
                destinationOrgId: '00DSHARED000000001'
            },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'SharedAccessProbe',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: bytes,
                    expectedAfterBytes: afterBytes
                }
            ]
        });
        const sealed = await access.captureService.sealSnapshot(ready.snapshotId);
        const loaded = await access.getSnapshot(sealed.snapshotId);
        const members = await access.getMembers(sealed.snapshotId);
        const artifact = await access.getArtifact(
            sealed.snapshotId,
            members[0].artifactId
        );

        assert.strictEqual(loaded.status, SNAPSHOT_STATUS.SEALED);
        assert.ok(artifact.equals(bytes));
        await access.verifySnapshotIntegrity(sealed.snapshotId);
    });
})();
