'use strict';

const assert = require('assert');

const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
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
const {
    createMemoryOrgLockStore
} = require('../deploymentOrgLock/stores/memoryOrgLockStore');
const {
    createUnavailableOrgLockStore
} = require('../deploymentOrgLock/stores/unavailableOrgLockStore');
const {
    createOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const { OPERATION_TYPE } = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    OrgLockIdentityError
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

const BASE_ARGS = {
    destinationOrgId: '00D000000000001',
    sourceOrgId: '00D000000000002',
    historyId: 'hist-1',
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

function createLockHarness(overrides = {}) {
    const metadataStore = createMemorySnapshotMetadataStore();
    const blobStore = createMemorySnapshotBlobStore();
    const innerCapture = createSnapshotCaptureService({
        metadataStore,
        blobStore
    });
    const order = [];
    const lockStore = overrides.lockStore || createMemoryOrgLockStore();
    const lockService =
        overrides.lockService || createOrgLockService({ store: lockStore });

    const service = createDestinationSnapshotCaptureService({
        captureService: {
            captureSnapshot: (...args) => innerCapture.captureSnapshot(...args),
            sealSnapshot: async (snapshotId) => {
                order.push('seal');
                return innerCapture.sealSnapshot(snapshotId);
            },
            getSnapshot: (...args) => innerCapture.getSnapshot(...args),
            getMembers: (...args) => innerCapture.getMembers(...args)
        },
        isSnapshotCaptureOnDeployEnabled:
            overrides.isCaptureEnabled || (() => false),
        isDeploymentOrgLockEnabled: overrides.isLockEnabled || (() => true),
        getOrgLockService: () => lockService,
        resolveVerifiedDestinationOrgId:
            overrides.resolveIdentity ||
            (async () => '00D000000000001'),
        startLockHeartbeat: overrides.startLockHeartbeat,
        createOwnerId: () => 'runtime-test:worker-1',
        enforceDurableCapture: false,
        refreshAccessToken: async () => ({
            accessToken: 'token',
            instanceUrl: 'https://dest.example.com'
        }),
        buildDestinationInventory: async (args) => {
            order.push('inventory');
            return inventoryFor(
                (args.items || []).map((item) => ({
                    ...item,
                    state: DESTINATION_STATE.EXISTS
                }))
            );
        },
        retrieveDestinationMember: async () => {
            order.push('retrieve');
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

    const originalAcquire = lockService.acquire.bind(lockService);
    lockService.acquire = (args) => {
        order.push('acquire');
        return originalAcquire(args);
    };

    return { service, order, lockService, lockStore };
}

(async () => {
    await runTest('lock flag OFF does not initialize lock or skip execution', async () => {
        let lockServiceCalled = false;
        let deployed = false;
        const service = createDestinationSnapshotCaptureService({
            isSnapshotCaptureOnDeployEnabled: () => false,
            isDeploymentOrgLockEnabled: () => false,
            getOrgLockService: () => {
                lockServiceCalled = true;
                throw new Error('lock must not initialize');
            },
            resolveVerifiedDestinationOrgId: async () => {
                throw new Error('identity must not run');
            }
        });

        const result = await service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(lockServiceCalled, false);
        assert.strictEqual(deployed, true);
        assert.strictEqual(result.snapshotBlocked, false);
    });

    await runTest('lock ON + store unavailable does not execute', async () => {
        let deployed = false;
        const harness = createLockHarness({
            lockService: createOrgLockService({
                store: createUnavailableOrgLockStore()
            })
        });

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(result.snapshotBlocked, true);
        assert.match(
            result.deploymentExecution.message,
            /not configured|unavailable/i
        );
    });

    await runTest('lock ON + LOCK_BUSY does not execute', async () => {
        const harness = createLockHarness();
        harness.lockService.acquire({
            destinationOrgId: '00D000000000001',
            ownerId: 'other',
            operationType: OPERATION_TYPE.DEPLOY
        });
        let deployed = false;

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(result.lockBusy, true);
    });

    await runTest('identity mismatch blocks deployment', async () => {
        let deployed = false;
        const harness = createLockHarness({
            resolveIdentity: async () => {
                throw new OrgLockIdentityError('mismatch');
            }
        });

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, false);
        assert.match(result.deploymentExecution.message, /mismatch/);
    });

    await runTest('successful acquire executes once and releases', async () => {
        const harness = createLockHarness();
        let deployed = 0;
        await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed += 1;
                const held = harness.lockService.get({
                    destinationOrgId: '00D000000000001'
                });
                assert.strictEqual(held.status, 'HELD');
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, 1);
        assert.strictEqual(
            harness.lockService.get({ destinationOrgId: '00D000000000001' })
                .status,
            'RELEASED'
        );
    });

    await runTest('release occurs when execution throws', async () => {
        const harness = createLockHarness();
        await assert.rejects(
            () =>
                harness.service.runDeployAfterOptionalSnapshot({
                    shouldDeploy: true,
                    captureArgs: BASE_ARGS,
                    runDeploymentExecution: async () => {
                        throw new Error('cli failed');
                    }
                }),
            /cli failed/
        );
        assert.strictEqual(
            harness.lockService.get({ destinationOrgId: '00D000000000001' })
                .status,
            'RELEASED'
        );
    });

    await runTest('history update failure still releases lock', async () => {
        const harness = createLockHarness();
        await assert.rejects(
            () =>
                harness.service.runDeployAfterOptionalSnapshot({
                    shouldDeploy: true,
                    captureArgs: BASE_ARGS,
                    runDeploymentExecution: async () => ({ status: 'Succeeded' }),
                    afterLockedExecution: async () => {
                        throw new Error('history failed');
                    }
                }),
            /history failed/
        );
        assert.strictEqual(
            harness.lockService.get({ destinationOrgId: '00D000000000001' })
                .status,
            'RELEASED'
        );
    });

    await runTest('generation mismatch before execution skips CLI', async () => {
        const harness = createLockHarness();
        harness.lockService.assertHeld = () => {
            const { OrgLockFenceError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
            throw new OrgLockFenceError();
        };
        let deployed = false;
        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(result.snapshotBlocked, true);
    });

    await runTest('capture ON acquires lock before destination retrieve', async () => {
        const harness = createLockHarness({
            isCaptureEnabled: () => true
        });
        let heldDuringExec = false;

        await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                heldDuringExec =
                    harness.lockService.get({
                        destinationOrgId: '00D000000000001'
                    }).status === 'HELD';
                return { status: 'Succeeded' };
            }
        });

        assert.ok(harness.order.indexOf('acquire') < harness.order.indexOf('inventory'));
        assert.ok(harness.order.indexOf('acquire') < harness.order.indexOf('retrieve'));
        assert.strictEqual(heldDuringExec, true);
        assert.ok(harness.order.includes('seal'));
    });

    await runTest('snapshot capture failure does not execute and releases lock', async () => {
        const harness = createLockHarness({
            isCaptureEnabled: () => true
        });
        const failingService = createDestinationSnapshotCaptureService({
            captureService: {
                captureSnapshot: async () => {
                    throw new Error('capture failed');
                },
                sealSnapshot: async () => {
                    throw new Error('should not seal');
                }
            },
            isSnapshotCaptureOnDeployEnabled: () => true,
            isDeploymentOrgLockEnabled: () => true,
            getOrgLockService: () => harness.lockService,
            resolveVerifiedDestinationOrgId: async () => '00D000000000001',
            createOwnerId: () => 'runtime-test:worker-1',
            enforceDurableCapture: false,
            refreshAccessToken: async () => ({
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com'
            }),
            buildDestinationInventory: async () =>
                inventoryFor([
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'AccountService',
                        state: DESTINATION_STATE.EXISTS
                    }
                ]),
            retrieveDestinationMember: async () => ({
                artifactBytes: Buffer.from('x'),
                files: []
            }),
            collectExpectedAfterArtifact: async () => ({
                expectedAfterHash: 'abc'
            })
        });

        let deployed = false;
        const result = await failingService.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(result.snapshotBlocked, true);
        assert.strictEqual(
            harness.lockService.get({ destinationOrgId: '00D000000000001' })
                .status,
            'RELEASED'
        );
    });

    await runTest('capture OFF + lock ON still protects deployment', async () => {
        const harness = createLockHarness({ isCaptureEnabled: () => false });
        let deployed = false;
        await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                assert.strictEqual(
                    harness.lockService.get({
                        destinationOrgId: '00D000000000001'
                    }).status,
                    'HELD'
                );
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, true);
        assert.deepStrictEqual(harness.order, ['acquire']);
    });

    await runTest('heartbeat failure does not steal lock', async () => {
        const events = [];
        let secondAcquireBusy = false;
        const harness = createLockHarness({
            startLockHeartbeat: ({ lockService }) => {
                events.push('heartbeat-started');
                try {
                    lockService.renew({
                        destinationOrgId: '00D000000000001',
                        ownerId: 'wrong',
                        leaseGeneration: 1
                    });
                } catch (error) {
                    events.push('heartbeat-failed');
                }

                return () => {
                    events.push('heartbeat-stopped');
                };
            }
        });

        await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                try {
                    harness.lockService.acquire({
                        destinationOrgId: '00D000000000001',
                        ownerId: 'other',
                        operationType: OPERATION_TYPE.DEPLOY
                    });
                } catch (error) {
                    secondAcquireBusy = /already locked/.test(error.message);
                }

                return { status: 'Succeeded' };
            }
        });

        assert.ok(events.includes('heartbeat-started'));
        assert.ok(events.includes('heartbeat-failed'));
        assert.ok(events.includes('heartbeat-stopped'));
        assert.strictEqual(secondAcquireBusy, true);
    });
})();
