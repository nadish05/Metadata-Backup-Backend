'use strict';

const assert = require('assert');

const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const { SNAPSHOT_STATUS } = require('./snapshot.types');
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
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const {
    createDestinationSnapshotCaptureService
} = require('./destinationSnapshotCapture.service');
const { createGate } = require('../deploymentOrgLock/lockTestGates');
const {
    createMemoryOrgLockStore
} = require('../deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createUnavailableOrgLockStore
} = require('../deploymentOrgLock/stores/unavailableOrgLockStore');
const {
    createOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const {
    OPERATION_TYPE,
    LOCK_STATUS
} = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    OrgLockStoreUnavailableError,
    OrgLockOwnershipError
} = require('../deploymentOrgLock/deploymentOrgLock.errors');

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

function inventoryFor(members) {
    const inventory = new Map();

    for (const member of members) {
        inventory.set(`${member.metadataType}:${member.metadataName}`, {
            state: member.state
        });
    }

    return { inventory };
}

function captureArgsFor(destinationOrgId, sourceOrgId) {
    return {
        destinationOrgId,
        sourceOrgId,
        historyId: `hist-${sourceOrgId}`,
        refreshToken: 'refresh-secret',
        instanceUrl: 'https://dest.example.com',
        generatedDeploymentPackage: {
            metadata: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService',
                    filePath: 'classes/AccountService.cls'
                }
            ]
        }
    };
}

function createPipeline({
    lockService,
    ownerId,
    destinationOrgId,
    isCaptureEnabled = () => false,
    isLockEnabled = () => true,
    startLockHeartbeat,
    buildDestinationInventory,
    retrieveDestinationMember,
    captureService,
    sealSnapshot
} = {}) {
    const order = [];
    const innerCapture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const capture = captureService || {
        captureSnapshot: async (...args) => {
            order.push('capture');
            return innerCapture.captureSnapshot(...args);
        },
        sealSnapshot: async (snapshotId) => {
            order.push('seal');
            if (typeof sealSnapshot === 'function') {
                return sealSnapshot(snapshotId, innerCapture);
            }

            return innerCapture.sealSnapshot(snapshotId);
        },
        getSnapshot: (...args) => innerCapture.getSnapshot(...args),
        getMembers: (...args) => innerCapture.getMembers(...args)
    };

    const originalAcquire = lockService.acquire.bind(lockService);
    const originalRelease = lockService.release.bind(lockService);

    if (!lockService.__p0r58Wrapped) {
        lockService.acquire = (args) => {
            order.push('acquire');
            return originalAcquire(args);
        };
        lockService.release = (args) => {
            order.push('release');
            return originalRelease(args);
        };
        lockService.__p0r58Wrapped = true;
        lockService.__p0r58Order = order;
    }

    const service = createDestinationSnapshotCaptureService({
        captureService: capture,
        isSnapshotCaptureOnDeployEnabled: isCaptureEnabled,
        isDeploymentOrgLockEnabled: isLockEnabled,
        getOrgLockService: () => lockService,
        resolveVerifiedDestinationOrgId: async () => destinationOrgId,
        startLockHeartbeat,
        createOwnerId: () => ownerId,
        enforceDurableCapture: false,
        refreshAccessToken: async () => ({
            accessToken: 'token',
            instanceUrl: 'https://dest.example.com'
        }),
        buildDestinationInventory:
            buildDestinationInventory ||
            (async (args) => {
                order.push('inventory');
                return inventoryFor(
                    (args.items || []).map((item) => ({
                        ...item,
                        state: DESTINATION_STATE.EXISTS
                    }))
                );
            }),
        retrieveDestinationMember:
            retrieveDestinationMember ||
            (async () => {
                order.push('retrieve');
                const bytes = packMemberFiles([
                    {
                        relativePath: 'classes/AccountService.cls',
                        bytes: Buffer.from('destination-before\r\n', 'utf8')
                    }
                ]);
                return { artifactBytes: bytes, files: [] };
            }),
        collectExpectedAfterArtifact: async () => {
            const bytes = packMemberFiles([
                {
                    relativePath: 'classes/AccountService.cls',
                    bytes: Buffer.from('destination-after\n', 'utf8')
                }
            ]);
            return {
                artifactBytes: bytes,
                expectedAfterHash: hashBytes(bytes)
            };
        }
    });

    return { service, order, lockService };
}

function createSharedLock() {
    const lockStore = createMemoryOrgLockStore();
    const lockService = createOrgLockService({ store: lockStore });

    return { lockStore, lockService };
}

(async () => {
    await runTest('same-org DEPLOY + DEPLOY: second is LOCK_BUSY and never executes', async () => {
        const { lockService } = createSharedLock();
        const dest = '00D-SAME';
        const enteredA = createGate();
        const proceedA = createGate();
        let executionA = 0;
        let executionB = 0;
        let retrieveB = 0;

        const pipelineA = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest
        });
        const pipelineB = createPipeline({
            lockService,
            ownerId: 'owner-b',
            destinationOrgId: dest,
            retrieveDestinationMember: async () => {
                retrieveB += 1;
                throw new Error('B must not retrieve');
            }
        });

        const runA = pipelineA.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => {
                enteredA.open();
                await proceedA.promise;
                executionA += 1;
                assert.strictEqual(
                    lockService.get({ destinationOrgId: dest }).status,
                    LOCK_STATUS.HELD
                );
                return { status: 'Succeeded' };
            }
        });

        await enteredA.promise;

        const resultB = await pipelineB.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceB'),
            runDeploymentExecution: async () => {
                executionB += 1;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(resultB.lockBusy, true);
        assert.strictEqual(executionB, 0);
        assert.strictEqual(retrieveB, 0);
        assert.strictEqual(
            lockService.get({ destinationOrgId: dest }).ownerId,
            'owner-a'
        );

        proceedA.open();
        await runA;

        assert.strictEqual(executionA, 1);
        assert.strictEqual(executionB, 0);
        assert.strictEqual(
            lockService.get({ destinationOrgId: dest }).status,
            LOCK_STATUS.RELEASED
        );
    });

    await runTest('different-org DEPLOY + DEPLOY both hold locks and execute', async () => {
        const { lockService } = createSharedLock();
        const enteredA = createGate();
        const enteredB = createGate();
        const proceedBoth = createGate();
        let executionA = 0;
        let executionB = 0;

        const pipelineA = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: '00DorgA'
        });
        const pipelineB = createPipeline({
            lockService,
            ownerId: 'owner-b',
            destinationOrgId: '00DorgB'
        });

        const runA = pipelineA.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor('00DorgA', '00DsourceA'),
            runDeploymentExecution: async () => {
                enteredA.open();
                await proceedBoth.promise;
                executionA += 1;
                return { status: 'Succeeded' };
            }
        });
        const runB = pipelineB.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor('00DorgB', '00DsourceB'),
            runDeploymentExecution: async () => {
                enteredB.open();
                await proceedBoth.promise;
                executionB += 1;
                return { status: 'Succeeded' };
            }
        });

        await Promise.all([enteredA.promise, enteredB.promise]);
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00DorgA' }).status,
            LOCK_STATUS.HELD
        );
        assert.strictEqual(
            lockService.get({ destinationOrgId: '00DorgB' }).status,
            LOCK_STATUS.HELD
        );

        proceedBoth.open();
        await Promise.all([runA, runB]);
        assert.strictEqual(executionA, 1);
        assert.strictEqual(executionB, 1);
    });

    await runTest('same destination different sources still conflict', async () => {
        const { lockService } = createSharedLock();
        const dest = '00DdestX';
        const enteredA = createGate();
        const proceedA = createGate();
        const pipelineA = createPipeline({
            lockService,
            ownerId: 'source-a',
            destinationOrgId: dest
        });
        const pipelineB = createPipeline({
            lockService,
            ownerId: 'source-b',
            destinationOrgId: dest
        });

        const runA = pipelineA.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => {
                enteredA.open();
                await proceedA.promise;
                return { status: 'Succeeded' };
            }
        });
        await enteredA.promise;
        const resultB = await pipelineB.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceB'),
            runDeploymentExecution: async () => ({ status: 'Succeeded' })
        });
        assert.strictEqual(resultB.lockBusy, true);
        proceedA.open();
        await runA;
    });

    await runTest('lock acquired before snapshot inventory and held through seal and execution', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dsnap';
        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest,
            isCaptureEnabled: () => true
        });
        let heldThroughHistory = false;
        let heldThroughExec = false;

        await pipeline.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => {
                heldThroughExec =
                    lockService.get({ destinationOrgId: dest }).status ===
                    LOCK_STATUS.HELD;
                return { status: 'Succeeded' };
            },
            afterLockedExecution: async () => {
                heldThroughHistory =
                    lockService.get({ destinationOrgId: dest }).status ===
                    LOCK_STATUS.HELD;
            }
        });

        const acquireAt = pipeline.order.indexOf('acquire');
        assert.ok(acquireAt >= 0);
        assert.ok(acquireAt < pipeline.order.indexOf('inventory'));
        assert.ok(acquireAt < pipeline.order.indexOf('retrieve'));
        assert.ok(acquireAt < pipeline.order.indexOf('capture'));
        assert.ok(acquireAt < pipeline.order.indexOf('seal'));
        assert.ok(pipeline.order.indexOf('release') > pipeline.order.indexOf('seal'));
        assert.strictEqual(heldThroughExec, true);
        assert.strictEqual(heldThroughHistory, true);
        assert.ok(!pipeline.order.slice(0, pipeline.order.indexOf('release')).includes('release'));
    });

    await runTest('LOCK_BUSY prevents snapshot work for the loser', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dbusy-snap';
        const enteredInventory = createGate();
        const proceedInventory = createGate();
        let inventoryB = 0;
        let retrieveB = 0;
        let captureB = 0;

        const pipelineA = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest,
            isCaptureEnabled: () => true,
            buildDestinationInventory: async (args) => {
                enteredInventory.open();
                await proceedInventory.promise;
                return inventoryFor(
                    (args.items || []).map((item) => ({
                        ...item,
                        state: DESTINATION_STATE.EXISTS
                    }))
                );
            }
        });
        const pipelineB = createPipeline({
            lockService,
            ownerId: 'owner-b',
            destinationOrgId: dest,
            isCaptureEnabled: () => true,
            buildDestinationInventory: async () => {
                inventoryB += 1;
                throw new Error('B must not inventory');
            },
            retrieveDestinationMember: async () => {
                retrieveB += 1;
                throw new Error('B must not retrieve');
            },
            captureService: {
                captureSnapshot: async () => {
                    captureB += 1;
                    throw new Error('B must not capture');
                },
                sealSnapshot: async () => {
                    throw new Error('B must not seal');
                }
            }
        });

        const runA = pipelineA.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => ({ status: 'Succeeded' })
        });
        await enteredInventory.promise;

        const resultB = await pipelineB.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceB'),
            runDeploymentExecution: async () => ({ status: 'Succeeded' })
        });

        assert.strictEqual(resultB.lockBusy, true);
        assert.strictEqual(inventoryB, 0);
        assert.strictEqual(retrieveB, 0);
        assert.strictEqual(captureB, 0);
        proceedInventory.open();
        await runA;
    });

    await runTest('snapshot capture failure releases lock so another deploy can acquire', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dcapfail';
        const failing = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest,
            isCaptureEnabled: () => true,
            captureService: {
                captureSnapshot: async () => {
                    throw new Error('capture failed');
                },
                sealSnapshot: async () => {
                    throw new Error('should not seal');
                }
            }
        });
        let executed = false;
        const failed = await failing.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => {
                executed = true;
                return { status: 'Succeeded' };
            }
        });
        assert.strictEqual(executed, false);
        assert.strictEqual(failed.snapshotBlocked, true);
        assert.strictEqual(
            lockService.get({ destinationOrgId: dest }).status,
            LOCK_STATUS.RELEASED
        );

        let recovered = false;
        const successor = createPipeline({
            lockService,
            ownerId: 'owner-b',
            destinationOrgId: dest
        });
        await successor.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceB'),
            runDeploymentExecution: async () => {
                recovered = true;
                return { status: 'Succeeded' };
            }
        });
        assert.strictEqual(recovered, true);
    });

    await runTest('snapshot seal failure does not execute and releases lock', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dseal';
        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest,
            isCaptureEnabled: () => true,
            sealSnapshot: async () => ({
                status: SNAPSHOT_STATUS.READY
            })
        });
        let executed = false;
        const result = await pipeline.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => {
                executed = true;
                return { status: 'Succeeded' };
            }
        });
        assert.strictEqual(executed, false);
        assert.strictEqual(result.snapshotBlocked, true);
        assert.strictEqual(
            lockService.get({ destinationOrgId: dest }).status,
            LOCK_STATUS.RELEASED
        );
    });

    await runTest('generation mismatch fences execution after acquire', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dgen';
        lockService.assertHeld = () => {
            const { OrgLockFenceError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
            throw new OrgLockFenceError();
        };
        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest
        });
        let executed = false;
        const result = await pipeline.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => {
                executed = true;
                return { status: 'Succeeded' };
            }
        });
        assert.strictEqual(executed, false);
        assert.strictEqual(result.snapshotBlocked, true);
    });

    await runTest('heartbeat stays active during paused execution then stops', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dhb-exec';
        const entered = createGate();
        const proceed = createGate();
        const ticks = [];
        let stopped = false;
        let tick = null;

        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest,
            startLockHeartbeat: ({ lockService: service, ...rest }) => {
                tick = () =>
                    service.renew({
                        destinationOrgId: rest.destinationOrgId,
                        ownerId: rest.ownerId,
                        leaseGeneration: rest.leaseGeneration
                    });
                return () => {
                    stopped = true;
                    tick = null;
                };
            }
        });

        const runA = pipeline.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor(dest, '00DsourceA'),
            runDeploymentExecution: async () => {
                entered.open();
                await proceed.promise;
                return { status: 'Succeeded' };
            }
        });

        await entered.promise;
        assert.strictEqual(stopped, false);
        const renewed = tick();
        ticks.push(renewed.lastHeartbeatAt);
        assert.strictEqual(renewed.ownerId, 'owner-a');
        proceed.open();
        await runA;
        assert.strictEqual(stopped, true);
        assert.strictEqual(tick, null);
    });

    await runTest('execution exception still releases the lock', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dexecfail';
        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest
        });
        await assert.rejects(
            () =>
                pipeline.service.runDeployAfterOptionalSnapshot({
                    shouldDeploy: true,
                    captureArgs: captureArgsFor(dest, '00DsourceA'),
                    runDeploymentExecution: async () => {
                        assert.strictEqual(
                            lockService.get({ destinationOrgId: dest }).status,
                            LOCK_STATUS.HELD
                        );
                        throw new Error('cli failed');
                    }
                }),
            /cli failed/
        );
        assert.strictEqual(
            lockService.get({ destinationOrgId: dest }).status,
            LOCK_STATUS.RELEASED
        );
    });

    await runTest('history failure still releases the lock', async () => {
        const { lockService } = createSharedLock();
        const dest = '00Dhistfail';
        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: dest
        });
        await assert.rejects(
            () =>
                pipeline.service.runDeployAfterOptionalSnapshot({
                    shouldDeploy: true,
                    captureArgs: captureArgsFor(dest, '00DsourceA'),
                    runDeploymentExecution: async () => ({ status: 'Succeeded' }),
                    afterLockedExecution: async () => {
                        throw new Error('history failed');
                    }
                }),
            /history failed/
        );
        assert.strictEqual(
            lockService.get({ destinationOrgId: dest }).status,
            LOCK_STATUS.RELEASED
        );
    });

    await runTest('store unavailable blocks execution and does not fall back', async () => {
        const lockService = createOrgLockService({
            store: createUnavailableOrgLockStore()
        });
        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: '00Dunavail'
        });
        let executed = false;
        const result = await pipeline.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor('00Dunavail', '00DsourceA'),
            runDeploymentExecution: async () => {
                executed = true;
                return { status: 'Succeeded' };
            }
        });
        assert.strictEqual(executed, false);
        assert.strictEqual(result.snapshotBlocked, true);
    });

    await runTest('release failure is observable and is not claimed as success', async () => {
        const store = createMemoryOrgLockStore();
        const lockService = createOrgLockService({ store });
        const originalRelease = store.release.bind(store);
        store.release = () => {
            throw new OrgLockOwnershipError('release failed');
        };
        const dest = '00Drelfail';
        const events = [];
        const originalLog = console.log;
        console.log = (...args) => {
            events.push(args.map((arg) => String(arg)).join(' '));
            originalLog.apply(console, args);
        };

        try {
            const pipeline = createPipeline({
                lockService,
                ownerId: 'owner-a',
                destinationOrgId: dest
            });
            await pipeline.service.runDeployAfterOptionalSnapshot({
                shouldDeploy: true,
                captureArgs: captureArgsFor(dest, '00DsourceA'),
                runDeploymentExecution: async () => ({ status: 'Succeeded' })
            });
        } finally {
            console.log = originalLog;
            store.release = originalRelease;
        }

        assert.ok(events.join('\n').includes('LOCK_RELEASE_FAILED'));
        assert.ok(!events.join('\n').includes('LOCK_RELEASED'));
    });

    await runTest('lock flag OFF does not identity-lock or heartbeat; execution still runs', async () => {
        let lockInit = false;
        let identity = false;
        let heartbeat = false;
        let inventory = 0;
        let executed = false;
        const service = createDestinationSnapshotCaptureService({
            isSnapshotCaptureOnDeployEnabled: () => true,
            isDeploymentOrgLockEnabled: () => false,
            getOrgLockService: () => {
                lockInit = true;
                throw new Error('lock must not initialize');
            },
            resolveVerifiedDestinationOrgId: async () => {
                identity = true;
                throw new Error('identity must not run');
            },
            startLockHeartbeat: () => {
                heartbeat = true;
                return () => {};
            },
            enforceDurableCapture: false,
            captureService: {
                captureSnapshot: async () => ({
                    snapshotId: 'snap-1',
                    status: SNAPSHOT_STATUS.READY
                }),
                sealSnapshot: async () => ({
                    snapshotId: 'snap-1',
                    status: SNAPSHOT_STATUS.SEALED
                })
            },
            refreshAccessToken: async () => ({
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com'
            }),
            buildDestinationInventory: async (args) => {
                inventory += 1;
                return inventoryFor(
                    (args.items || []).map((item) => ({
                        ...item,
                        state: DESTINATION_STATE.EXISTS
                    }))
                );
            },
            retrieveDestinationMember: async () => {
                const bytes = packMemberFiles([
                    {
                        relativePath: 'classes/AccountService.cls',
                        bytes: Buffer.from('destination-before\r\n', 'utf8')
                    }
                ]);
                return { artifactBytes: bytes, files: [] };
            },
            collectExpectedAfterArtifact: async () => {
                const bytes = packMemberFiles([
                    {
                        relativePath: 'classes/AccountService.cls',
                        bytes: Buffer.from('destination-after\n', 'utf8')
                    }
                ]);
                return {
                    artifactBytes: bytes,
                    expectedAfterHash: hashBytes(bytes)
                };
            }
        });

        await service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor('00Doff', '00DsourceA'),
            runDeploymentExecution: async () => {
                executed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(lockInit, false);
        assert.strictEqual(identity, false);
        assert.strictEqual(heartbeat, false);
        assert.strictEqual(inventory, 1);
        assert.strictEqual(executed, true);
    });

    await runTest('acquire store failure does not execute', async () => {
        const store = {
            acquire: () => {
                throw new OrgLockStoreUnavailableError('store down');
            },
            renew: () => {
                throw new OrgLockStoreUnavailableError('store down');
            },
            release: () => {
                throw new OrgLockStoreUnavailableError('store down');
            },
            get: () => null,
            adminRelease: () => {
                throw new OrgLockStoreUnavailableError('store down');
            }
        };
        const lockService = createOrgLockService({ store });
        const pipeline = createPipeline({
            lockService,
            ownerId: 'owner-a',
            destinationOrgId: '00Ddown'
        });
        let executed = false;
        const result = await pipeline.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: captureArgsFor('00Ddown', '00DsourceA'),
            runDeploymentExecution: async () => {
                executed = true;
                return { status: 'Succeeded' };
            }
        });
        assert.strictEqual(executed, false);
        assert.strictEqual(result.snapshotBlocked, true);
    });
})();
