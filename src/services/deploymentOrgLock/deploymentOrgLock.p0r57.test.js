'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createMemoryOrgLockStore
} = require('./stores/memoryOrgLockStore');
const {
    createFileOrgLockStore
} = require('./stores/fileOrgLockStore');
const {
    createUnavailableOrgLockStore
} = require('./stores/unavailableOrgLockStore');
const { createOrgLockService } = require('./deploymentOrgLock.service');
const { OPERATION_TYPE, LOCK_STATUS } = require('./deploymentOrgLock.types');
const {
    OrgLockBusyError,
    OrgLockOwnershipError,
    OrgLockStoreUnavailableError
} = require('./deploymentOrgLock.errors');
const {
    isDeploymentOrgLockEnabled,
    FLAG_ENV
} = require('./deploymentOrgLock.flag');
const {
    resolveVerifiedDestinationOrgId
} = require('./destinationOrgIdentity.service');
const { OrgLockIdentityError } = require('./deploymentOrgLock.errors');
const { startLockHeartbeat } = require('./deploymentOrgLock.heartbeat');
const {
    LOCK_PRODUCTION_DISTRIBUTED_READY
} = require('./deploymentOrgLock.types');

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'p0r57-lock-'));
}

function createService(store) {
    return createOrgLockService({ store, leaseMs: 5 * 60 * 1000 });
}

(async () => {
    await runTest('lock flag defaults OFF', () => {
        const previous = process.env[FLAG_ENV];
        delete process.env[FLAG_ENV];

        try {
            assert.strictEqual(isDeploymentOrgLockEnabled(), false);
        } finally {
            if (previous === undefined) {
                delete process.env[FLAG_ENV];
            } else {
                process.env[FLAG_ENV] = previous;
            }
        }
    });

    await runTest('production distributed readiness remains false', () => {
        assert.strictEqual(LOCK_PRODUCTION_DISTRIBUTED_READY, false);
    });

    await runTest('acquire succeeds', () => {
        const service = createService(createMemoryOrgLockStore());
        const acquired = service.acquire({
            destinationOrgId: '00D000000000001',
            ownerId: 'runtime-a:worker-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        assert.strictEqual(acquired.status, LOCK_STATUS.HELD);
        assert.strictEqual(acquired.destinationOrgId, '00D000000000001');
        assert.strictEqual(acquired.leaseGeneration, 1);
        assert.ok(acquired.lockId);
        assert.ok(!JSON.stringify(acquired).includes('refreshToken'));
    });

    await runTest('second owner same org is LOCK_BUSY', () => {
        const service = createService(createMemoryOrgLockStore());
        service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00DorgA',
                    ownerId: 'owner-2',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockBusyError
        );
    });

    await runTest('different org acquires independently', () => {
        const service = createService(createMemoryOrgLockStore());
        const first = service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });
        const second = service.acquire({
            destinationOrgId: '00DorgB',
            ownerId: 'owner-2',
            operationType: OPERATION_TYPE.ROLLBACK
        });

        assert.strictEqual(first.destinationOrgId, '00DorgA');
        assert.strictEqual(second.destinationOrgId, '00DorgB');
        assert.strictEqual(second.operationType, OPERATION_TYPE.ROLLBACK);
    });

    await runTest('renew succeeds and wrong owner/generation fail', () => {
        const service = createService(createMemoryOrgLockStore());
        const acquired = service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        const renewed = service.renew({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            leaseGeneration: acquired.leaseGeneration
        });
        assert.ok(renewed.lastHeartbeatAt);

        assert.throws(
            () =>
                service.renew({
                    destinationOrgId: '00DorgA',
                    ownerId: 'owner-2',
                    leaseGeneration: acquired.leaseGeneration
                }),
            OrgLockOwnershipError
        );
        assert.throws(
            () =>
                service.renew({
                    destinationOrgId: '00DorgA',
                    ownerId: 'owner-1',
                    leaseGeneration: acquired.leaseGeneration + 1
                }),
            OrgLockOwnershipError
        );
    });

    await runTest('release is idempotent for same owner and rejected for others', () => {
        const service = createService(createMemoryOrgLockStore());
        const acquired = service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        service.release({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            leaseGeneration: acquired.leaseGeneration
        });
        const again = service.release({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            leaseGeneration: acquired.leaseGeneration
        });
        assert.strictEqual(again.status, LOCK_STATUS.RELEASED);

        assert.throws(
            () =>
                service.release({
                    destinationOrgId: '00DorgA',
                    ownerId: 'owner-2',
                    leaseGeneration: acquired.leaseGeneration
                }),
            OrgLockOwnershipError
        );
    });

    await runTest('expired lease is not auto-stolen', () => {
        const store = createMemoryOrgLockStore({
            now: () => Date.parse('2020-01-01T00:00:00.000Z')
        });
        const service = createOrgLockService({
            store,
            leaseMs: 1,
            now: () => Date.parse('2020-01-01T00:00:00.000Z')
        });
        service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });

        const later = createOrgLockService({
            store,
            now: () => Date.parse('2026-01-01T00:00:00.000Z')
        });

        assert.throws(
            () =>
                later.acquire({
                    destinationOrgId: '00DorgA',
                    ownerId: 'owner-2',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockBusyError
        );
    });

    await runTest('adminRelease then next acquire increments generation', () => {
        const service = createService(createMemoryOrgLockStore());
        const first = service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });
        service.adminRelease({
            destinationOrgId: '00DorgA',
            reason: 'break-glass',
            actor: 'operator'
        });
        const second = service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-2',
            operationType: OPERATION_TYPE.DEPLOY
        });

        assert.ok(second.leaseGeneration > first.leaseGeneration);
        assert.strictEqual(second.ownerId, 'owner-2');
    });

    await runTest('filesystem store rejects path traversal and expired steal', () => {
        const root = tempRoot();
        const store = createFileOrgLockStore({ rootDir: root });
        const service = createService(store);

        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '../etc',
                    ownerId: 'owner-1',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            TypeError
        );

        const acquired = service.acquire({
            destinationOrgId: '00Dfile1',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });
        const raw = fs.readFileSync(
            path.join(root, 'org-locks', '00Dfile1.json'),
            'utf8'
        );
        assert.ok(!raw.includes('refreshToken'));
        assert.ok(!raw.includes('accessToken'));

        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00Dfile1',
                    ownerId: 'owner-2',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockBusyError
        );

        service.release({
            destinationOrgId: '00Dfile1',
            ownerId: 'owner-1',
            leaseGeneration: acquired.leaseGeneration
        });
        fs.rmSync(root, { recursive: true, force: true });
    });

    await runTest('unconfigured store fails closed', () => {
        const service = createService(createUnavailableOrgLockStore());
        assert.throws(
            () =>
                service.acquire({
                    destinationOrgId: '00DorgA',
                    ownerId: 'owner-1',
                    operationType: OPERATION_TYPE.DEPLOY
                }),
            OrgLockStoreUnavailableError
        );
    });

    await runTest('identity uses verified org and rejects mismatch', async () => {
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
            requestedOrgId: null,
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
                    requestedOrgId: '00Dclient',
                    refreshAccessTokenFn: async () => ({
                        accessToken: 'token',
                        instanceUrl: 'https://dest.example.com'
                    }),
                    fetchUserInfo: async () => ({
                        organization_id: '00Dactual'
                    })
                }),
            OrgLockIdentityError
        );

        await assert.rejects(
            () =>
                resolveVerifiedDestinationOrgId({
                    refreshToken: 'refresh',
                    instanceUrl: 'https://dest.example.com',
                    fetchUserInfo: async () => {
                        throw new Error('network');
                    },
                    refreshAccessTokenFn: async () => ({
                        accessToken: 'token',
                        instanceUrl: 'https://dest.example.com'
                    })
                }),
            OrgLockIdentityError
        );
    });

    await runTest('heartbeat renews then stops', async () => {
        const store = createMemoryOrgLockStore();
        const service = createService(store);
        const acquired = service.acquire({
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            operationType: OPERATION_TYPE.DEPLOY
        });
        let renews = 0;
        const originalRenew = service.renew.bind(service);
        service.renew = (args) => {
            renews += 1;
            return originalRenew(args);
        };

        const stop = startLockHeartbeat({
            lockService: service,
            destinationOrgId: '00DorgA',
            ownerId: 'owner-1',
            leaseGeneration: acquired.leaseGeneration,
            heartbeatMs: 20
        });

        await new Promise((resolve) => setTimeout(resolve, 70));
        assert.ok(renews >= 1);
        const count = renews;
        stop();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.strictEqual(renews, count);
    });
})();
