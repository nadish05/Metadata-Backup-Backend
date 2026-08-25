'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGate } = require('./lockTestGates');
const {
    createMemoryOrgLockStore
} = require('./stores/memoryOrgLockStore');
const {
    createFileOrgLockStore
} = require('./stores/fileOrgLockStore');
const { createOrgLockService } = require('./deploymentOrgLock.service');
const { startLockHeartbeat } = require('./deploymentOrgLock.heartbeat');
const {
    OPERATION_TYPE,
    LOCK_STATUS,
    LOCK_PRODUCTION_DISTRIBUTED_READY
} = require('./deploymentOrgLock.types');
const {
    OrgLockBusyError,
    OrgLockOwnershipError
} = require('./deploymentOrgLock.errors');
const {
    resolveVerifiedDestinationOrgId
} = require('./destinationOrgIdentity.service');
const { OrgLockIdentityError } = require('./deploymentOrgLock.errors');

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

function captureLogs(fn) {
    const events = [];
    const original = console.log;
    console.log = (...args) => {
        events.push(args.map((arg) => String(arg)).join(' '));
        original.apply(console, args);
    };

    return Promise.resolve()
        .then(fn)
        .finally(() => {
            console.log = original;
        })
        .then((result) => ({ result, events }));
}

(async () => {
    await runTest('DEPLOY vs future ROLLBACK share destination lock', () => {
        const service = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const deploy = service.acquire({
            destinationOrgId: '00Dsame',
            ownerId: 'deploy-owner',
            operationType: OPERATION_TYPE.DEPLOY
        });

        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00Dsame',
                    ownerId: 'rollback-owner',
                    operationType: OPERATION_TYPE.ROLLBACK
                }),
            OrgLockBusyError
        );

        service.release({
            destinationOrgId: '00Dsame',
            ownerId: 'deploy-owner',
            leaseGeneration: deploy.leaseGeneration
        });

        const rollback = service.acquire({
            destinationOrgId: '00Dsame',
            ownerId: 'rollback-owner',
            operationType: OPERATION_TYPE.ROLLBACK
        });
        assert.strictEqual(rollback.operationType, OPERATION_TYPE.ROLLBACK);

        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00Dsame',
                    ownerId: 'deploy-owner-2',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockBusyError
        );

        service.release({
            destinationOrgId: '00Dsame',
            ownerId: 'rollback-owner',
            leaseGeneration: rollback.leaseGeneration
        });
    });

    await runTest('ROLLBACK vs ROLLBACK same org is LOCK_BUSY', () => {
        const service = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        service.acquire({
            destinationOrgId: '00Dsame',
            ownerId: 'rb-a',
            operationType: OPERATION_TYPE.ROLLBACK
        });

        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00Dsame',
                    ownerId: 'rb-b',
                    operationType: OPERATION_TYPE.ROLLBACK
                }),
            OrgLockBusyError
        );
    });

    await runTest('source org is not the lock key', () => {
        const service = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        service.acquire({
            destinationOrgId: '00DdestX',
            ownerId: 'source-a',
            operationType: OPERATION_TYPE.DEPLOY,
            historyId: 'hist-source-a'
        });

        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00DdestX',
                    ownerId: 'source-b',
                    operationType: OPERATION_TYPE.DEPLOY,
                    historyId: 'hist-source-b'
                }),
            OrgLockBusyError
        );

        const other = service.acquire({
            destinationOrgId: '00DdestY',
            ownerId: 'source-b',
            operationType: OPERATION_TYPE.DEPLOY
        });
        assert.strictEqual(other.destinationOrgId, '00DdestY');
    });

    await runTest('expired HELD lock is not auto-stolen', () => {
        const store = createMemoryOrgLockStore({
            now: () => Date.parse('2020-01-01T00:00:00.000Z')
        });
        const service = createOrgLockService({
            store,
            leaseMs: 1,
            now: () => Date.parse('2020-01-01T00:00:00.000Z')
        });
        service.acquire({
            destinationOrgId: '00Dexp',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        assert.throws(
            () =>
                createOrgLockService({
                    store,
                    now: () => Date.parse('2026-01-01T00:00:00.000Z')
                }).acquire({
                    destinationOrgId: '00Dexp',
                    ownerId: 'owner-2',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockBusyError
        );

        createOrgLockService({ store }).adminRelease({
            destinationOrgId: '00Dexp',
            reason: 'operator confirmed idle',
            actor: 'admin'
        });

        const recovered = createOrgLockService({ store }).acquire({
            destinationOrgId: '00Dexp',
            ownerId: 'owner-2',
            operationType: OPERATION_TYPE.DEPLOY
        });
        assert.strictEqual(recovered.ownerId, 'owner-2');
    });

    await runTest('filesystem cross-instance serializes the same org', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r58-fs-'));
        const left = createOrgLockService({
            store: createFileOrgLockStore({ rootDir: root })
        });
        const right = createOrgLockService({
            store: createFileOrgLockStore({ rootDir: root })
        });

        left.acquire({
            destinationOrgId: '00Dshared',
            ownerId: 'instance-a',
            operationType: OPERATION_TYPE.DEPLOY
        });

        assert.throws(
            () =>
                right.acquire({
                    destinationOrgId: '00Dshared',
                    ownerId: 'instance-b',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockBusyError
        );

        const otherOrg = right.acquire({
            destinationOrgId: '00Dother',
            ownerId: 'instance-b',
            operationType: OPERATION_TYPE.DEPLOY
        });
        assert.strictEqual(otherOrg.status, LOCK_STATUS.HELD);

        const raw = fs.readFileSync(
            path.join(root, 'org-locks', '00Dshared.json'),
            'utf8'
        );
        assert.ok(!raw.includes('refreshToken'));
        assert.ok(!raw.includes('accessToken'));

        assert.throws(
            () =>
                left.acquire({
                    destinationOrgId: '../passwd',
                    ownerId: 'instance-a',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            TypeError
        );

        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('lock events never include credentials', async () => {
        const { events } = await captureLogs(() => {
            const service = createOrgLockService({
                store: createMemoryOrgLockStore()
            });
            const acquired = service.acquire({
                destinationOrgId: '00Dlog',
                ownerId: 'owner-1',
                operationType: OPERATION_TYPE.DEPLOY,
                historyId: 'hist-1'
            });
            service.renew({
                destinationOrgId: '00Dlog',
                ownerId: 'owner-1',
                leaseGeneration: acquired.leaseGeneration
            });
            try {
                service.acquire({
                    destinationOrgId: '00Dlog',
                    ownerId: 'owner-2',
                    operationType: OPERATION_TYPE.DEPLOY
                });
            } catch (error) {
                assert.ok(error instanceof OrgLockBusyError);
            }
            try {
                service.release({
                    destinationOrgId: '00Dlog',
                    ownerId: 'wrong',
                    leaseGeneration: acquired.leaseGeneration
                });
            } catch (error) {
                assert.ok(error instanceof OrgLockOwnershipError);
            }
        });

        const joined = events.join('\n');
        assert.ok(joined.includes('LOCK_ACQUIRE_REQUESTED'));
        assert.ok(joined.includes('LOCK_ACQUIRED'));
        assert.ok(joined.includes('LOCK_BUSY'));
        assert.ok(joined.includes('LOCK_RENEWED'));
        assert.ok(joined.includes('LOCK_RELEASE_FAILED'));
        assert.ok(!joined.includes('refreshToken'));
        assert.ok(!joined.includes('accessToken'));
        assert.ok(!joined.includes('Authorization'));
        assert.ok(!joined.includes('Bearer'));
    });

    await runTest('LOCK_RECOVERY_REQUIRED is emitted for adminRelease', async () => {
        const { events } = await captureLogs(() => {
            const service = createOrgLockService({
                store: createMemoryOrgLockStore()
            });
            service.acquire({
                destinationOrgId: '00Drec',
                ownerId: 'owner-1',
                operationType: OPERATION_TYPE.DEPLOY
            });
            service.adminRelease({
                destinationOrgId: '00Drec',
                reason: 'break-glass',
                actor: 'operator'
            });
        });

        const joined = events.join('\n');
        assert.ok(joined.includes('LOCK_RECOVERY_REQUIRED'));
        assert.ok(joined.includes('LOCK_RELEASED'));
    });

    await runTest('identity malformed org id is blocked', async () => {
        await assert.rejects(
            () =>
                resolveVerifiedDestinationOrgId({
                    refreshToken: 'refresh',
                    instanceUrl: 'https://dest.example.com',
                    refreshAccessTokenFn: async () => ({
                        accessToken: 'token',
                        instanceUrl: 'https://dest.example.com'
                    }),
                    fetchUserInfo: async () => ({})
                }),
            OrgLockIdentityError
        );
    });

    await runTest('production distributed readiness remains false', () => {
        assert.strictEqual(LOCK_PRODUCTION_DISTRIBUTED_READY, false);
    });

    await runTest('createGate is deterministic without sleeps', async () => {
        const gate = createGate();
        let opened = false;
        const waiter = gate.promise.then(() => {
            opened = true;
        });
        assert.strictEqual(opened, false);
        gate.open();
        await waiter;
        assert.strictEqual(opened, true);
    });

    await runTest('identity match, missing request org, mismatch, and lookup failure', async () => {
        const verified = await resolveVerifiedDestinationOrgId({
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com',
            requestedOrgId: '00Dverified',
            refreshAccessTokenFn: async () => ({
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com'
            }),
            fetchUserInfo: async () => ({ organization_id: '00Dverified' })
        });
        assert.strictEqual(verified, '00Dverified');

        const inferred = await resolveVerifiedDestinationOrgId({
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com',
            refreshAccessTokenFn: async () => ({
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com'
            }),
            fetchUserInfo: async () => ({ organization_id: '00DfromToken' })
        });
        assert.strictEqual(inferred, '00DfromToken');

        await assert.rejects(
            () =>
                resolveVerifiedDestinationOrgId({
                    refreshToken: 'refresh',
                    instanceUrl: 'https://dest.example.com',
                    requestedOrgId: '00Drequested',
                    refreshAccessTokenFn: async () => ({
                        accessToken: 'token',
                        instanceUrl: 'https://dest.example.com'
                    }),
                    fetchUserInfo: async () => ({ organization_id: '00Dactual' })
                }),
            OrgLockIdentityError
        );

        await assert.rejects(
            () =>
                resolveVerifiedDestinationOrgId({
                    refreshToken: 'refresh',
                    instanceUrl: 'https://dest.example.com',
                    refreshAccessTokenFn: async () => ({
                        accessToken: 'token',
                        instanceUrl: 'https://dest.example.com'
                    }),
                    fetchUserInfo: async () => {
                        throw new Error('network');
                    }
                }),
            OrgLockIdentityError
        );
    });

    await runTest('injected heartbeat renews then stops without leaking timers', async () => {
        const service = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const acquired = service.acquire({
            destinationOrgId: '00Dhb',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        let tick = null;
        let cleared = 0;
        const handle = { unref() {} };

        const stop = startLockHeartbeat({
            lockService: service,
            destinationOrgId: acquired.destinationOrgId,
            ownerId: acquired.ownerId,
            leaseGeneration: acquired.leaseGeneration,
            setIntervalFn: (fn) => {
                tick = fn;
                return handle;
            },
            clearIntervalFn: (id) => {
                assert.strictEqual(id, handle);
                cleared += 1;
            }
        });

        tick();
        const held = service.get({ destinationOrgId: '00Dhb' });
        assert.ok(held.lastHeartbeatAt);
        stop();
        assert.strictEqual(cleared, 1);
        stop();
        assert.strictEqual(cleared, 2);
    });

    await runTest('heartbeat renew failure is observable and does not steal', async () => {
        const service = createOrgLockService({
            store: createMemoryOrgLockStore()
        });
        const acquired = service.acquire({
            destinationOrgId: '00Dhb2',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        let tick = null;
        const { events } = await captureLogs(() => {
            const stop = startLockHeartbeat({
                lockService: {
                    renew: () => {
                        throw new Error('renew failed');
                    }
                },
                destinationOrgId: acquired.destinationOrgId,
                ownerId: acquired.ownerId,
                leaseGeneration: acquired.leaseGeneration,
                setIntervalFn: (fn) => {
                    tick = fn;
                    return { unref() {} };
                },
                clearIntervalFn: () => {}
            });
            tick();
            stop();
        });

        assert.ok(events.join('\n').includes('LOCK_HEARTBEAT_FAILED'));
        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00Dhb2',
                    ownerId: 'owner-2',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockBusyError
        );
        assert.strictEqual(
            service.get({ destinationOrgId: '00Dhb2' }).status,
            LOCK_STATUS.HELD
        );
    });
})();
