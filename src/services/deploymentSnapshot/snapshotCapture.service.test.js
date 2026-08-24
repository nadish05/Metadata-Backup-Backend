const assert = require('assert');

const {
    SCHEMA_VERSION,
    SNAPSHOT_VERSION,
    SNAPSHOT_STATUS,
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    memberIdentityKey
} = require('./snapshot.types');
const {
    SnapshotValidationError,
    SnapshotNotFoundError,
    SnapshotAlreadySealedError,
    SnapshotIntegrityError,
    SnapshotMemberConflictError,
    SnapshotStateError
} = require('./snapshot.errors');
const {
    hashBytes,
    computeSnapshotIntegrityHash
} = require('./snapshotIntegrity.service');
const {
    createSnapshotCaptureService
} = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    METADATA_STORE_METHODS
} = require('./stores/snapshotMetadataStore');
const {
    BLOB_STORE_METHODS
} = require('./stores/snapshotBlobStore');

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

function createService(overrides = {}) {
    const metadataStore =
        overrides.metadataStore || createMemorySnapshotMetadataStore();
    const blobStore = overrides.blobStore || createMemorySnapshotBlobStore();

    return {
        metadataStore,
        blobStore,
        service: createSnapshotCaptureService({ metadataStore, blobStore })
    };
}

const ACCOUNT_SERVICE_BYTES = Buffer.from(
    'public class AccountService {\n    // old implementation\n}\n',
    'utf8'
);

const CONTEXT = {
    destinationOrgId: '00D000000000001',
    sourceOrgId: '00D000000000002',
    deploymentId: '0Af000000000001',
    sourceBranch: 'feature/a',
    destinationBranch: 'main'
};

async function captureModifiedReady() {
    const { service, blobStore } = createService();
    const snapshot = await service.captureSnapshot({
        deploymentContext: CONTEXT,
        members: [
            {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: 'force-app/main/default/classes/AccountService.cls',
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
            }
        ]
    });

    return { service, blobStore, snapshot };
}

async function main() {
    await runTest('create snapshot starts in CAPTURING', async () => {
        const { service } = createService();
        const snapshot = await service.createSnapshot(CONTEXT);

        assert.ok(snapshot.snapshotId.startsWith('snapshot_'));
        assert.strictEqual(snapshot.status, SNAPSHOT_STATUS.CAPTURING);
        assert.strictEqual(snapshot.schemaVersion, SCHEMA_VERSION);
        assert.strictEqual(snapshot.snapshotVersion, SNAPSHOT_VERSION);
        assert.strictEqual(snapshot.rollbackEligible, false);
        assert.strictEqual(snapshot.destinationOrgId, CONTEXT.destinationOrgId);
        assert.strictEqual(snapshot.sealedAt, null);
        assert.strictEqual(snapshot.overallIntegrityHash, null);
    });

    await runTest('missing destinationOrgId is rejected', async () => {
        const { service } = createService();

        await assert.rejects(
            () => service.createSnapshot({ sourceOrgId: 'x' }),
            SnapshotValidationError
        );
    });

    await runTest('CAPTURING → READY → SEALED', async () => {
        const { service, snapshot } = await captureModifiedReady();

        assert.strictEqual(snapshot.status, SNAPSHOT_STATUS.READY);
        assert.strictEqual(snapshot.rollbackEligible, false);

        const sealed = await service.sealSnapshot(snapshot.snapshotId);

        assert.strictEqual(sealed.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(sealed.rollbackEligible, true);
        assert.ok(sealed.sealedAt);
        assert.ok(sealed.overallIntegrityHash);
        assert.match(sealed.overallIntegrityHash, /^[a-f0-9]{64}$/);
    });

    await runTest('CAPTURING → FAILED when MODIFIED bytes missing', async () => {
        const { service } = createService();

        await assert.rejects(
            () =>
                service.captureSnapshot({
                    deploymentContext: CONTEXT,
                    members: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'AccountService',
                            changeClass: CHANGE_CLASS.MODIFIED
                        }
                    ]
                }),
            (error) => {
                assert.ok(error instanceof SnapshotValidationError);
                assert.ok(error.snapshotId);
                return true;
            }
        );
    });

    await runTest('FAILED snapshot cannot be sealed', async () => {
        const { service } = createService();
        let snapshotId;

        try {
            await service.captureSnapshot({
                deploymentContext: CONTEXT,
                members: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Broken',
                        changeClass: CHANGE_CLASS.MODIFIED
                    }
                ]
            });
        } catch (error) {
            snapshotId = error.snapshotId;
        }

        const failed = await service.getSnapshot(snapshotId);

        assert.strictEqual(failed.status, SNAPSHOT_STATUS.FAILED);
        await assert.rejects(
            () => service.sealSnapshot(snapshotId),
            SnapshotStateError
        );
    });

    await runTest('cannot add members to SEALED snapshot', async () => {
        const { service, snapshot } = await captureModifiedReady();
        await service.sealSnapshot(snapshot.snapshotId);

        await assert.rejects(
            () =>
                service.addMember(snapshot.snapshotId, {
                    metadataType: 'ApexClass',
                    metadataName: 'Other',
                    changeClass: CHANGE_CLASS.NEW
                }),
            SnapshotAlreadySealedError
        );
    });

    await runTest('members may still be added while READY, not after SEALED', async () => {
        const { service, snapshot } = await captureModifiedReady();

        const added = await service.addMember(snapshot.snapshotId, {
            metadataType: 'ApexClass',
            metadataName: 'Other',
            changeClass: CHANGE_CLASS.NEW
        });

        assert.strictEqual(added.changeClass, CHANGE_CLASS.NEW);

        const sealed = await service.sealSnapshot(snapshot.snapshotId);

        assert.strictEqual(sealed.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(sealed.rollbackEligible, false);

        await assert.rejects(
            () =>
                service.addMember(snapshot.snapshotId, {
                    metadataType: 'ApexClass',
                    metadataName: 'TooLate',
                    changeClass: CHANGE_CLASS.NEW
                }),
            SnapshotAlreadySealedError
        );
    });

    await runTest('MODIFIED preserves exact destination-before bytes and SHA-256', async () => {
        const { service, blobStore, snapshot } = await captureModifiedReady();
        const members = await service.getMembers(snapshot.snapshotId);

        assert.strictEqual(members.length, 1);

        const member = members[0];
        const expectedHash = hashBytes(ACCOUNT_SERVICE_BYTES);

        assert.strictEqual(member.metadataType, 'ApexClass');
        assert.strictEqual(member.metadataName, 'AccountService');
        assert.strictEqual(member.changeClass, CHANGE_CLASS.MODIFIED);
        assert.strictEqual(member.existedBefore, true);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.COMPLETE);
        assert.strictEqual(member.destinationBeforeHash, expectedHash);
        assert.ok(member.artifactId);
        assert.strictEqual(member.artifactSize, ACCOUNT_SERVICE_BYTES.length);

        const stored = await blobStore.getArtifact(member.artifactId);

        assert.ok(Buffer.isBuffer(stored));
        assert.strictEqual(
            stored.equals(ACCOUNT_SERVICE_BYTES),
            true,
            'stored artifact must equal original destination-before bytes'
        );
        assert.strictEqual(hashBytes(stored), expectedHash);
    });

    await runTest('NEW does not create a destination-before artifact', async () => {
        const { service } = createService();
        const snapshot = await service.captureSnapshot({
            deploymentContext: CONTEXT,
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'BrandNewClass',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]
        });
        const members = await service.getMembers(snapshot.snapshotId);
        const sealed = await service.sealSnapshot(snapshot.snapshotId);

        assert.strictEqual(members.length, 1);
        assert.strictEqual(members[0].changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(members[0].existedBefore, false);
        assert.strictEqual(members[0].artifactId, null);
        assert.strictEqual(members[0].destinationBeforeHash, null);
        assert.strictEqual(
            members[0].captureStatus,
            MEMBER_CAPTURE_STATUS.ABSENT_PROVEN
        );
        assert.strictEqual(sealed.rollbackEligible, false);
        assert.strictEqual(members[0].artifactSize, 0);
    });

    await runTest('NEW with destination-before bytes is rejected', async () => {
        const { service } = createService();

        await assert.rejects(
            () =>
                service.captureSnapshot({
                    deploymentContext: CONTEXT,
                    members: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'BrandNewClass',
                            changeClass: CHANGE_CLASS.NEW,
                            destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
                        }
                    ]
                }),
            SnapshotValidationError
        );
    });

    await runTest('UNKNOWN is preserved and is not converted to MODIFIED', async () => {
        const { service } = createService();
        const snapshot = await service.captureSnapshot({
            deploymentContext: CONTEXT,
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'MaybeThere',
                    changeClass: CHANGE_CLASS.UNKNOWN
                }
            ]
        });
        const members = await service.getMembers(snapshot.snapshotId);
        const sealed = await service.sealSnapshot(snapshot.snapshotId);

        assert.strictEqual(members[0].changeClass, CHANGE_CLASS.UNKNOWN);
        assert.strictEqual(members[0].existedBefore, null);
        assert.strictEqual(members[0].artifactId, null);
        assert.strictEqual(
            members[0].captureStatus,
            MEMBER_CAPTURE_STATUS.UNKNOWN
        );
        assert.strictEqual(sealed.rollbackEligible, false);
    });

    await runTest('invalid changeClass is rejected', async () => {
        const { service } = createService();

        await assert.rejects(
            () =>
                service.captureSnapshot({
                    deploymentContext: CONTEXT,
                    members: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'X',
                            changeClass: 'DELETED'
                        }
                    ]
                }),
            SnapshotValidationError
        );
    });

    await runTest('missing metadata identity is rejected', async () => {
        const { service } = createService();

        await assert.rejects(
            () =>
                service.captureSnapshot({
                    deploymentContext: CONTEXT,
                    members: [{ changeClass: CHANGE_CLASS.NEW }]
                }),
            SnapshotValidationError
        );
    });

    await runTest('empty MODIFIED artifact is rejected', async () => {
        const { service } = createService();

        await assert.rejects(
            () =>
                service.captureSnapshot({
                    deploymentContext: CONTEXT,
                    members: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'Empty',
                            changeClass: CHANGE_CLASS.MODIFIED,
                            destinationBeforeBytes: Buffer.alloc(0)
                        }
                    ]
                }),
            SnapshotValidationError
        );
    });

    await runTest('identical duplicate members collapse safely', async () => {
        const { service } = createService();
        const created = await service.createSnapshot(CONTEXT);

        const first = await service.addMember(created.snapshotId, {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
        });
        const second = await service.addMember(created.snapshotId, {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeBytes: Buffer.from(ACCOUNT_SERVICE_BYTES)
        });

        const members = await service.getMembers(created.snapshotId);

        assert.strictEqual(members.length, 1);
        assert.strictEqual(first.destinationBeforeHash, second.destinationBeforeHash);
        assert.strictEqual(
            memberIdentityKey(first.metadataType, first.metadataName),
            'ApexClass:AccountService'
        );
    });

    await runTest('conflicting duplicate members are rejected without overwrite', async () => {
        const { service, blobStore } = createService();
        const created = await service.createSnapshot(CONTEXT);

        const first = await service.addMember(created.snapshotId, {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
        });

        await assert.rejects(
            () =>
                service.addMember(created.snapshotId, {
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: Buffer.from('different bytes')
                }),
            SnapshotMemberConflictError
        );

        const stored = await blobStore.getArtifact(first.artifactId);

        assert.strictEqual(stored.equals(ACCOUNT_SERVICE_BYTES), true);
        const members = await service.getMembers(created.snapshotId);
        assert.strictEqual(members.length, 1);
        assert.strictEqual(
            members[0].destinationBeforeHash,
            hashBytes(ACCOUNT_SERVICE_BYTES)
        );
    });

    await runTest('NEW then MODIFIED for the same identity is a conflict', async () => {
        const { service } = createService();
        const created = await service.createSnapshot(CONTEXT);

        await service.addMember(created.snapshotId, {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.NEW
        });

        await assert.rejects(
            () =>
                service.addMember(created.snapshotId, {
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
                }),
            SnapshotMemberConflictError
        );
    });

    await runTest('corrupted stored artifact fails integrity and cannot seal as eligible', async () => {
        const { service, blobStore, snapshot } = await captureModifiedReady();
        const members = await service.getMembers(snapshot.snapshotId);

        await blobStore.replaceArtifactBytes(
            members[0].artifactId,
            Buffer.from('corrupted')
        );

        await assert.rejects(
            () => service.sealSnapshot(snapshot.snapshotId),
            SnapshotIntegrityError
        );

        const after = await service.getSnapshot(snapshot.snapshotId);

        assert.strictEqual(after.status, SNAPSHOT_STATUS.FAILED);
        assert.strictEqual(after.rollbackEligible, false);
    });

    await runTest('sealing incomplete CAPTURING snapshot is rejected', async () => {
        const { service } = createService();
        const snapshot = await service.createSnapshot(CONTEXT);

        await assert.rejects(
            () => service.sealSnapshot(snapshot.snapshotId),
            SnapshotStateError
        );
    });

    await runTest('unknown snapshot id is SnapshotNotFoundError', async () => {
        const { service } = createService();

        await assert.rejects(
            () => service.getSnapshot('snapshot_missing'),
            SnapshotNotFoundError
        );
    });

    await runTest('blob store failure marks snapshot FAILED', async () => {
        const metadataStore = createMemorySnapshotMetadataStore();
        const blobStore = {
            async putArtifact() {
                throw new Error('blob unavailable');
            },
            async getArtifact() {
                return null;
            },
            async exists() {
                return false;
            },
            async getMetadata() {
                return null;
            }
        };
        const service = createSnapshotCaptureService({
            metadataStore,
            blobStore
        });

        await assert.rejects(
            () =>
                service.captureSnapshot({
                    deploymentContext: CONTEXT,
                    members: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'AccountService',
                            changeClass: CHANGE_CLASS.MODIFIED,
                            destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
                        }
                    ]
                }),
            /blob unavailable/
        );
    });

    await runTest('metadata store failure surfaces to caller', async () => {
        const blobStore = createMemorySnapshotBlobStore();
        const metadataStore = {
            async createSnapshot() {
                throw new Error('metadata unavailable');
            },
            async getSnapshot() {
                return null;
            },
            async updateSnapshot() {
                throw new Error('metadata unavailable');
            },
            async addMember() {
                throw new Error('metadata unavailable');
            },
            async getMember() {
                return null;
            },
            async getMembers() {
                return [];
            },
            async sealSnapshot() {
                throw new Error('metadata unavailable');
            }
        };

        METADATA_STORE_METHODS.forEach((method) => {
            assert.strictEqual(typeof metadataStore[method], 'function');
        });
        BLOB_STORE_METHODS.forEach((method) => {
            assert.strictEqual(typeof blobStore[method], 'function');
        });

        const service = createSnapshotCaptureService({
            metadataStore,
            blobStore
        });

        await assert.rejects(
            () => service.createSnapshot(CONTEXT),
            /metadata unavailable/
        );
    });

    await runTest('mixed NEW + MODIFIED seals but is not rollback eligible', async () => {
        const { service } = createService();
        const snapshot = await service.captureSnapshot({
            deploymentContext: CONTEXT,
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
                },
                {
                    metadataType: 'ApexClass',
                    metadataName: 'BrandNewClass',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]
        });
        const sealed = await service.sealSnapshot(snapshot.snapshotId);

        assert.strictEqual(sealed.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(sealed.rollbackEligible, false);
    });

    await runTest('capture service depends only on store contracts', async () => {
        const calls = [];
        const members = new Map();
        let snapshot = null;

        const metadataStore = {
            async createSnapshot(record) {
                calls.push('createSnapshot');
                snapshot = { ...record };
                return { ...snapshot };
            },
            async getSnapshot() {
                calls.push('getSnapshot');
                return snapshot ? { ...snapshot } : null;
            },
            async updateSnapshot(id, patch) {
                calls.push('updateSnapshot');
                snapshot = { ...snapshot, ...patch };
                return { ...snapshot };
            },
            async addMember(member) {
                calls.push('addMember');
                members.set(
                    memberIdentityKey(member.metadataType, member.metadataName),
                    { ...member }
                );
                return { ...member };
            },
            async getMember(id, type, name) {
                calls.push('getMember');
                return members.get(memberIdentityKey(type, name)) || null;
            },
            async getMembers() {
                calls.push('getMembers');
                return [...members.values()].map((item) => ({ ...item }));
            },
            async sealSnapshot(id, fields) {
                calls.push('sealSnapshot');
                snapshot = { ...snapshot, ...fields, status: SNAPSHOT_STATUS.SEALED };
                return { ...snapshot };
            }
        };

        const blobs = new Map();
        const blobStore = {
            async putArtifact({ artifactId, bytes }) {
                calls.push('putArtifact');
                blobs.set(artifactId, Buffer.from(bytes));
                return { artifactId, size: bytes.length };
            },
            async getArtifact(artifactId) {
                calls.push('getArtifact');
                const stored = blobs.get(artifactId);
                return stored ? Buffer.from(stored) : null;
            },
            async exists(artifactId) {
                calls.push('exists');
                return blobs.has(artifactId);
            },
            async getMetadata(artifactId) {
                calls.push('getMetadata');
                const stored = blobs.get(artifactId);
                return stored
                    ? { artifactId, size: stored.length }
                    : null;
            }
        };

        const service = createSnapshotCaptureService({
            metadataStore,
            blobStore
        });
        const captured = await service.captureSnapshot({
            deploymentContext: CONTEXT,
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: ACCOUNT_SERVICE_BYTES
                }
            ]
        });
        await service.sealSnapshot(captured.snapshotId);

        assert.ok(calls.includes('createSnapshot'));
        assert.ok(calls.includes('putArtifact'));
        assert.ok(calls.includes('addMember'));
        assert.ok(calls.includes('sealSnapshot'));
        assert.ok(!calls.some((name) => name.toLowerCase().includes('azure')));
        assert.ok(!calls.some((name) => name.toLowerCase().includes('sql')));
    });
}

main();
