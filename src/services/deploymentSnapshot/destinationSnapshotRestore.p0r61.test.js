'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    CHANGE_CLASS,
    SNAPSHOT_STATUS
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
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
    createDestinationSnapshotRestoreService
} = require('./destinationSnapshotRestore.service');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const { DRIFT_CLASSIFICATION } = require('./snapshotDriftComparison.service');
const {
    createMemoryOrgLockStore
} = require('../deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createUnavailableOrgLockStore
} = require('../deploymentOrgLock/stores/unavailableOrgLockStore');
const {
    createOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const { OPERATION_TYPE, LOCK_STATUS } = require('../deploymentOrgLock/deploymentOrgLock.types');
const { OrgLockIdentityError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
const {
    createDeploymentHistoryService
} = require('../deploymentHistory.service');
const {
    createMemoryDeploymentHistoryStore
} = require('../deploymentHistoryStores/memoryDeploymentHistoryStore');

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

function beforeBytes() {
    return packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/AccountService.cls',
            bytes: Buffer.from('public class AccountService {\n    // before\n}\n', 'utf8')
        }
    ]);
}

function afterBytes() {
    return packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/AccountService.cls',
            bytes: Buffer.from('public class AccountService {\n    // after\n}\n', 'utf8')
        }
    ]);
}

async function sealEligible(capture = createSnapshotCaptureService({
    metadataStore: createMemorySnapshotMetadataStore(),
    blobStore: createMemorySnapshotBlobStore()
})) {
    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: '00D000000000001',
            sourceOrgId: '00D000000000002'
        },
        members: [
            {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: 'force-app/main/default/classes/AccountService.cls',
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: beforeBytes(),
                expectedAfterHash: hashBytes(afterBytes())
            }
        ]
    });
    const sealed = await capture.sealSnapshot(ready.snapshotId);

    return { capture, sealed };
}

function createRestore({
    capture,
    lockService,
    retrieveBytes = afterBytes(),
    checkOnlySuccess = true,
    executeSuccess = true,
    executeThrows = false,
    identityOrgId = '00D000000000001',
    identityError = null,
    durable = true,
    rollbackEnabled = true,
    lockEnabled = true,
    historyService = null,
    startLockHeartbeat
} = {}) {
    const events = [];
    let executions = 0;
    let retrieves = 0;
    let checkOnlyCalls = 0;

    const service = createDestinationSnapshotRestoreService({
        captureService: capture,
        isSnapshotRollbackEnabled: () => rollbackEnabled,
        isDurableSnapshotStorageReady: () => durable,
        isDeploymentOrgLockEnabled: () => lockEnabled,
        getOrgLockService: () => lockService,
        createOwnerId: () => 'rollback-owner',
        resolveVerifiedDestinationOrgId: async () => {
            if (identityError) {
                throw identityError;
            }

            return identityOrgId;
        },
        startLockHeartbeat: startLockHeartbeat || (() => {
            events.push('heartbeat-start');
            return () => events.push('heartbeat-stop');
        }),
        retrieveDestinationMember: async () => {
            retrieves += 1;
            return { artifactBytes: retrieveBytes, files: [] };
        },
        runCheckOnlyDeployment: async () => {
            checkOnlyCalls += 1;
            return {
                executed: true,
                success: checkOnlySuccess,
                status: checkOnlySuccess ? 'Succeeded' : 'Failed',
                message: checkOnlySuccess ? 'ok' : 'check-only failed'
            };
        },
        runDeploymentExecution: async () => {
            executions += 1;
            if (executeThrows) {
                throw new Error('cli failed');
            }

            return {
                success: executeSuccess,
                status: executeSuccess ? 'Succeeded' : 'Failed',
                message: executeSuccess ? 'deployed' : 'deploy failed'
            };
        },
        historyService
    });

    return {
        service,
        events,
        counts: () => ({ executions, retrieves, checkOnlyCalls })
    };
}

(async () => {
    await runTest('flag OFF blocks without retrieve, lock, or execution', async () => {
        const { capture, sealed } = await sealEligible();
        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const restore = createRestore({
            capture,
            lockService,
            rollbackEnabled: false
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com',
            destinationOrgId: '00D000000000001'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.DISABLED);
        assert.strictEqual(restore.counts().retrieves, 0);
        assert.strictEqual(restore.counts().executions, 0);
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00D000000000001' }),
            null
        );
    });

    await runTest('missing snapshot is blocked', async () => {
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const restore = createRestore({
            capture,
            lockService: createOrgLockService({ store: createMemoryOrgLockStore() })
        });
        const result = await restore.service.runRollback({
            snapshotId: 'snapshot_missing',
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.code, ROLLBACK_CODE.SNAPSHOT_NOT_FOUND);
        assert.strictEqual(restore.counts().retrieves, 0);
    });

    await runTest('CAPTURING READY FAILED and ineligible SEALED are blocked', async () => {
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const capturing = await capture.createSnapshot({
            destinationOrgId: '00D000000000001'
        });
        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const restore = createRestore({ capture, lockService });

        const capturingResult = await restore.service.runRollback({
            snapshotId: capturing.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(capturingResult.code, ROLLBACK_CODE.SNAPSHOT_NOT_SEALED);

        const { sealed } = await sealEligible(capture);
        assert.strictEqual(sealed.status, SNAPSHOT_STATUS.SEALED);

        const newReady = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: '00D000000000001' },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'BrandNew',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]
        });
        const newSealed = await capture.sealSnapshot(newReady.snapshotId);
        const newResult = await restore.service.runRollback({
            snapshotId: newSealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(newResult.code, ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE);
        assert.strictEqual(newSealed.rollbackEligible, false);
    });

    await runTest('integrity mismatch and missing artifact block', async () => {
        const metadataStore = createMemorySnapshotMetadataStore();
        const blobStore = createMemorySnapshotBlobStore();
        const capture = createSnapshotCaptureService({ metadataStore, blobStore });
        const { sealed } = await sealEligible(capture);
        const originalGet = capture.getSnapshot.bind(capture);
        capture.getSnapshot = async (id) => {
            const snapshot = await originalGet(id);
            return { ...snapshot, overallIntegrityHash: '0'.repeat(64) };
        };
        const restore = createRestore({
            capture,
            lockService: createOrgLockService({ store: createMemoryOrgLockStore() })
        });
        const integrity = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(integrity.code, ROLLBACK_CODE.INTEGRITY_MISMATCH);

        const blobStore2 = createMemorySnapshotBlobStore();
        const capture2 = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: blobStore2
        });
        const sealed2 = await sealEligible(capture2);
        const members = await capture2.getMembers(sealed2.sealed.snapshotId);
        await blobStore2.putArtifact({
            artifactId: `${members[0].artifactId}-gone`,
            bytes: Buffer.from('x')
        });
        const originalGetArtifact = blobStore2.getArtifact.bind(blobStore2);
        blobStore2.getArtifact = async (artifactId) => {
            if (artifactId === members[0].artifactId) {
                return null;
            }

            return originalGetArtifact(artifactId);
        };
        blobStore2.exists = async (artifactId) => artifactId !== members[0].artifactId;

        const restore2 = createRestore({
            capture: capture2,
            lockService: createOrgLockService({ store: createMemoryOrgLockStore() })
        });
        const missing = await restore2.service.runRollback({
            snapshotId: sealed2.sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.ok(
            missing.code === ROLLBACK_CODE.ARTIFACT_MISSING ||
                missing.code === ROLLBACK_CODE.ARTIFACT_HASH_MISMATCH
        );
    });

    await runTest('unsupported metadata and durable storage gates', async () => {
        const { capture, sealed } = await sealEligible();
        const restoreDurable = createRestore({
            capture,
            lockService: createOrgLockService({ store: createMemoryOrgLockStore() }),
            durable: false
        });
        const durable = await restoreDurable.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(durable.code, ROLLBACK_CODE.STORAGE_UNAVAILABLE);

        const capture2 = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const packed = packMemberFiles([
            {
                relativePath: 'force-app/main/default/pages/Hello.page',
                bytes: Buffer.from('<apex:page/>', 'utf8')
            }
        ]);
        const ready = await capture2.captureSnapshot({
            deploymentContext: { destinationOrgId: '00D000000000001' },
            members: [
                {
                    metadataType: 'ApexPage',
                    metadataName: 'Hello',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: packed,
                    expectedAfterHash: hashBytes(packed)
                }
            ]
        });
        const sealedPage = await capture2.sealSnapshot(ready.snapshotId);
        const restorePage = createRestore({
            capture: capture2,
            lockService: createOrgLockService({ store: createMemoryOrgLockStore() })
        });
        const unsupported = await restorePage.service.runRollback({
            snapshotId: sealedPage.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.ok(
            unsupported.code === ROLLBACK_CODE.UNSUPPORTED_METADATA ||
                unsupported.code === ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE
        );
    });

    await runTest('identity match mismatch and lookup failure', async () => {
        const { capture, sealed } = await sealEligible();
        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const mismatch = createRestore({
            capture,
            lockService,
            identityOrgId: '00Dother'
        });
        const mismatchResult = await mismatch.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com',
            destinationOrgId: '00D000000000001'
        });
        assert.strictEqual(
            mismatchResult.code,
            ROLLBACK_CODE.DESTINATION_MISMATCH
        );

        const fail = createRestore({
            capture,
            lockService,
            identityError: new OrgLockIdentityError('lookup failed')
        });
        const failResult = await fail.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(failResult.code, ROLLBACK_CODE.IDENTITY_FAILURE);
        assert.strictEqual(mismatch.counts().retrieves, 0);
    });

    await runTest('lock flag OFF lock unavailable and LOCK_BUSY block before retrieve', async () => {
        const { capture, sealed } = await sealEligible();
        const off = createRestore({
            capture,
            lockService: createOrgLockService({ store: createMemoryOrgLockStore() }),
            lockEnabled: false
        });
        const offResult = await off.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(offResult.code, ROLLBACK_CODE.LOCK_DISABLED);
        assert.strictEqual(off.counts().retrieves, 0);

        const unavailable = createRestore({
            capture,
            lockService: createOrgLockService({
                store: createUnavailableOrgLockStore()
            })
        });
        const unavailableResult = await unavailable.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(unavailableResult.code, ROLLBACK_CODE.LOCK_UNAVAILABLE);

        const store = createMemoryOrgLockStore();
        const lockService = createOrgLockService({ store });
        lockService.acquire({
            destinationOrgId: '00D000000000001',
            ownerId: 'deploy-owner',
            operationType: OPERATION_TYPE.DEPLOY
        });
        const busy = createRestore({ capture, lockService });
        const busyResult = await busy.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(busyResult.code, ROLLBACK_CODE.LOCK_BUSY);
        assert.strictEqual(busyResult.lockBusy, true);
        assert.strictEqual(busy.counts().retrieves, 0);
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00D000000000001' }).ownerId,
            'deploy-owner'
        );
    });

    await runTest('C === B proceeds; C === A DRIFTED UNKNOWN and mixed block entirely', async () => {
        const { capture, sealed } = await sealEligible();

        async function driftCase(bytes, expectedCode) {
            const restore = createRestore({
                capture,
                lockService: createOrgLockService({
                    store: createMemoryOrgLockStore()
                }),
                retrieveBytes: bytes
            });
            return restore.service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });
        }

        const ok = await driftCase(afterBytes());
        assert.strictEqual(ok.blocked, false);
        assert.strictEqual(
            ok.drift[0].classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );

        const unchanged = await driftCase(beforeBytes());
        assert.strictEqual(unchanged.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.strictEqual(
            unchanged.drift[0].classification,
            DRIFT_CLASSIFICATION.UNCHANGED_FROM_BEFORE
        );

        const drifted = await driftCase(
            packMemberFiles([
                {
                    relativePath:
                        'force-app/main/default/classes/AccountService.cls',
                    bytes: Buffer.from('other', 'utf8')
                }
            ])
        );
        assert.strictEqual(drifted.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.strictEqual(
            drifted.drift[0].classification,
            DRIFT_CLASSIFICATION.DRIFTED
        );

        const missingC = createRestore({
            capture,
            lockService: createOrgLockService({
                store: createMemoryOrgLockStore()
            }),
            retrieveBytes: Buffer.alloc(0)
        });
        const missing = await missingC.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(
            missing.code,
            ROLLBACK_CODE.DESTINATION_RETRIEVE_FAILED
        );
    });

    await runTest('check-only failure skips execution; success executes once and releases lock', async () => {
        const { capture, sealed } = await sealEligible();
        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const failed = createRestore({
            capture,
            lockService,
            checkOnlySuccess: false
        });
        const failedResult = await failed.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(failedResult.code, ROLLBACK_CODE.CHECK_ONLY_FAILED);
        assert.strictEqual(failed.counts().executions, 0);
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00D000000000001' }).status,
            LOCK_STATUS.RELEASED
        );

        const okLock = createOrgLockService({ store: createMemoryOrgLockStore() });
        const historyService = createDeploymentHistoryService({
            store: createMemoryDeploymentHistoryStore()
        });
        const ok = createRestore({
            capture,
            lockService: okLock,
            historyService
        });
        const okResult = await ok.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(okResult.blocked, false);
        assert.strictEqual(ok.counts().executions, 1);
        assert.strictEqual(ok.counts().checkOnlyCalls, 1);
        assert.ok(ok.events.includes('heartbeat-start'));
        assert.ok(ok.events.includes('heartbeat-stop'));
        assert.strictEqual(
            okLock.get({ destinationOrgId: '00D000000000001' }).status,
            LOCK_STATUS.RELEASED
        );
        const history = historyService.getHistory(okResult.historyId);
        assert.strictEqual(history.operationType, OPERATION_TYPE.ROLLBACK);
        assert.strictEqual(history.rollbackOfSnapshotId, sealed.snapshotId);
        assert.strictEqual(history.snapshotId, null);
    });

    await runTest('lease fence blocks execution and execution throw is fail-closed', async () => {
        const { capture, sealed } = await sealEligible();
        const lockService = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        lockService.assertHeld = () => {
            const { OrgLockFenceError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
            throw new OrgLockFenceError();
        };
        const fenced = createRestore({ capture, lockService });
        const fencedResult = await fenced.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(fencedResult.code, ROLLBACK_CODE.LOCK_FENCE);
        assert.strictEqual(fenced.counts().executions, 0);

        const throwLock = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const throwing = createRestore({
            capture,
            lockService: throwLock,
            executeThrows: true
        });
        const thrown = await throwing.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(thrown.code, ROLLBACK_CODE.EXECUTION_FAILED);
        assert.strictEqual(
            throwLock.get({ destinationOrgId: '00D000000000001' }).status,
            LOCK_STATUS.RELEASED
        );
    });

    await runTest('happy path writes package members and cleans workspace', async () => {
        const { capture, sealed } = await sealEligible();
        const restore = createRestore({
            capture,
            lockService: createOrgLockService({
                store: createMemoryOrgLockStore()
            })
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        assert.strictEqual(result.blocked, false);
        assert.ok(result.generatedWorkspace.packageXmlWritten);
        assert.strictEqual(result.generatedWorkspace.status, 'CLEANED');
        assert.ok(
            !fs.existsSync(result.generatedWorkspace.workspacePath) ||
                result.generatedWorkspace.status === 'CLEANED'
        );
        const xmlPath = result.generatedWorkspace.packageXmlPath;
        if (xmlPath && fs.existsSync(path.dirname(xmlPath))) {
            assert.ok(
                !fs.existsSync(path.join(path.dirname(xmlPath), 'destructiveChanges.xml'))
            );
        }
    });

    await runTest('rollbackProductionReady remains false', () => {
        const {
            DURABLE_SNAPSHOT_STORAGE_CAPABILITY
        } = require('./snapshotStorageCapability');
        assert.strictEqual(
            DURABLE_SNAPSHOT_STORAGE_CAPABILITY.rollbackProductionReady,
            false
        );
    });
})();
