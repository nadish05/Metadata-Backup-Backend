'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError,
    sanitizeControlPlaneText
} = require('./controlPlane.errors');
const {
    createTestControlPlaneAuthProvider,
    resolveControlPlaneAuth
} = require('./controlPlane.auth');
const { createSalesforceControlPlaneClient } = require('./controlPlane.client');
const {
    createSalesforceControlPlaneSnapshotBlobStore
} = require('./stores/salesforceControlPlaneSnapshotBlobStore');
const {
    createSalesforceControlPlaneDeploymentHistoryStore
} = require('./stores/salesforceControlPlaneDeploymentHistoryStore');
const {
    createSalesforceControlPlaneRollbackOperationStore
} = require('./stores/salesforceControlPlaneRollbackOperationStore');
const {
    createSalesforceControlPlaneOrgLockStore
} = require('./stores/salesforceControlPlaneOrgLockStore');
const {
    OrgLockBusyError,
    OrgLockOwnershipError
} = require('../deploymentOrgLock/deploymentOrgLock.errors');
const {
    CONTROL_PLANE_SCHEMA_DECISIONS,
    LOCK_MULTI_REPLICA_PROOF
} = require('./controlPlane.schemaDecisions');
const { LOCK_PRODUCTION_DISTRIBUTED_READY } = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    CONTROL_ORG_MODE,
    resolveControlPlaneStorageMode
} = require('./controlPlane.mode');

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

function hashBytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function ok(record, extras = {}) {
    return {
        status: 200,
        data: {
            success: true,
            record,
            recordId: record && record.Id,
            ...extras
        }
    };
}

function fail(status, code, message, extras = {}) {
    return {
        status,
        data: {
            success: false,
            code,
            message,
            ...extras
        }
    };
}

function controlPlaneParts(url) {
    const withoutQuery = String(url).split('?')[0];
    const marker = '/control-plane/';
    const index = withoutQuery.indexOf(marker);
    if (index < 0) {
        return [];
    }

    return withoutQuery
        .slice(index + marker.length)
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
}

function createMockHttp(router) {
    const calls = [];

    async function httpRequest(config) {
        const normalized = {
            ...config,
            body: config.data
        };
        calls.push({
            method: String(normalized.method || 'GET').toUpperCase(),
            url: normalized.url,
            body: normalized.body,
            params: normalized.params,
            headers: normalized.headers,
            authorization: normalized.headers && normalized.headers.Authorization,
            contentType: normalized.headers && normalized.headers['Content-Type'],
            responseType: normalized.responseType
        });

        return router(normalized, calls);
    }

    return { httpRequest, calls };
}

function createClient(httpRequest, extras = {}) {
    return createSalesforceControlPlaneClient({
        accessToken: extras.accessToken || 'test-control-plane-access-token',
        instanceUrl: extras.instanceUrl || 'https://control-org.example.invalid',
        timeoutMs: extras.timeoutMs || 50,
        httpRequest
    });
}

function operationRecord(overrides = {}) {
    return {
        Operation_Id__c: 'rbo-1',
        Destination_Org_Id__c: '00Ddest',
        Snapshot_Id__c: 'snapshot_1',
        Rollback_Scope_Key__c: '00Ddest|snapshot_1',
        Status__c: 'NOT_STARTED',
        Retry_Of_Operation_Id__c: null,
        Created_At__c: '2026-08-26T06:00:00.000Z',
        Updated_At__c: '2026-08-26T06:00:00.000Z',
        Execution_Started_At__c: null,
        Completed_At__c: null,
        Salesforce_Deployment_Id__c: null,
        Result_Code__c: null,
        Result_Message__c: null,
        ...overrides
    };
}

function lockRecord(overrides = {}) {
    return {
        Id: 'a00xx0000000001',
        Destination_Org_Id__c: '00Ddest',
        Owner_Id__c: 'owner-1',
        Lease_Generation__c: 1,
        Status__c: 'HELD',
        Operation_Type__c: 'DEPLOY',
        Acquired_At__c: '2026-08-26T06:00:00.000Z',
        Expires_At__c: '2026-08-26T06:15:00.000Z',
        Last_Heartbeat_At__c: '2026-08-26T06:00:00.000Z',
        History_Id__c: 'hist-1',
        Snapshot_Id__c: null,
        ...overrides
    };
}

function historySfRecord(overrides = {}) {
    return {
        Id: 'a01xx0000000001',
        Backend_History_Id__c: 'hist-001',
        Snapshot_Id__c: 'snapshot_1',
        Rollback_Of_History_Id__c: 'hist-000',
        Deployment_ID__c: '0AfJOB1',
        Deployment_Status__c: 'SUCCESS',
        ...overrides
    };
}

function createArtifactRouter({ sealedSnapshots = new Set() } = {}) {
    const files = new Map();
    let documentSeq = 1;

    function keyFor(snapshotId, artifactId) {
        return `${snapshotId}::${artifactId}`;
    }

    return function artifactRouter(config) {
        const parts = controlPlaneParts(config.url);
        const method = String(config.method || 'GET').toUpperCase();

        if (parts[0] !== 'snapshots' || parts[2] !== 'artifacts') {
            return fail(404, 'NOT_FOUND', 'Unknown');
        }

        const snapshotId = parts[1];
        const artifactId =
            (config.params && config.params.artifactId) ||
            (config.headers && config.headers['X-Control-Plane-Artifact-Id']) ||
            parts[3];

        if (method === 'POST' || method === 'PUT') {
            if (String(artifactId || '').includes('..')) {
                return fail(400, 'INVALID_REQUEST', 'artifactId must be a snapshots/ relative path.');
            }

            const embedded = String(artifactId || '').split('/')[1];
            if (embedded && embedded !== snapshotId) {
                return fail(404, 'NOT_FOUND', 'Artifact does not belong to this snapshot.');
            }

            if (sealedSnapshots.has(snapshotId) && files.has(keyFor(snapshotId, artifactId))) {
                return fail(409, 'SEALED', 'SEALED snapshots are immutable.');
            }

            const bytes = Buffer.isBuffer(config.body)
                ? config.body
                : Buffer.from(config.body || []);
            const stored = {
                bytes: Buffer.from(bytes),
                contentDocumentId: `069xx00000000${documentSeq++}`,
                size: bytes.length
            };
            files.set(keyFor(snapshotId, artifactId), stored);

            return {
                status: 200,
                data: {
                    success: true,
                    artifactId,
                    size: stored.size,
                    contentDocumentId: stored.contentDocumentId
                }
            };
        }

        if (method === 'GET') {
            const embedded = String(artifactId || '').split('/')[1];
            if (embedded && embedded !== snapshotId) {
                return fail(404, 'NOT_FOUND', 'Artifact does not belong to this snapshot.');
            }

            const stored = files.get(keyFor(snapshotId, artifactId));
            if (!stored) {
                return fail(404, 'NOT_FOUND', 'Artifact file is not associated.');
            }

            if (parts[4] === 'exists') {
                return {
                    status: 200,
                    data: {
                        success: true,
                        exists: true,
                        artifactId,
                        size: stored.size,
                        contentDocumentId: stored.contentDocumentId
                    }
                };
            }

            if (parts[4] === 'metadata') {
                return {
                    status: 200,
                    data: {
                        success: true,
                        artifactId,
                        size: stored.size,
                        contentDocumentId: stored.contentDocumentId
                    }
                };
            }

            return {
                status: 200,
                data: Buffer.from(stored.bytes)
            };
        }

        return fail(400, 'INVALID_REQUEST', 'Unknown route.');
    };
}

(async () => {
    await runTest('1. auth unavailable', () => {
        const resolved = resolveControlPlaneAuth();
        assert.strictEqual(resolved.ok, false);
        assert.strictEqual(
            resolved.error.code,
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
        );
    });

    await runTest('2. auth success with test provider', () => {
        const provider = createTestControlPlaneAuthProvider();
        const resolved = resolveControlPlaneAuth({ provider });
        assert.strictEqual(resolved.ok, true);
        assert.strictEqual(resolved.source, 'test-control-plane-auth-provider');
        assert.ok(resolved.accessToken);
        assert.ok(resolved.instanceUrl);
        assert.notStrictEqual(resolved.source, 'destination-refresh-token');
    });

    await runTest('3. 401', async () => {
        const client = createClient(async () => ({
            status: 401,
            data: [{ message: 'Session expired', errorCode: 'INVALID_SESSION_ID' }]
        }));
        await assert.rejects(
            () => client.controlPlane('GET', '/snapshots/x'),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
        );
    });

    await runTest('4. 403', async () => {
        const client = createClient(async () =>
            fail(403, 'UNAUTHORIZED', 'Insufficient access')
        );
        await assert.rejects(
            () => client.controlPlane('GET', '/snapshots/x'),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_PERMISSION_DENIED
        );
    });

    await runTest('5. timeout', async () => {
        const client = createClient(async () => {
            const error = new Error('timeout of 50ms exceeded');
            error.code = 'ECONNABORTED';
            throw error;
        });
        await assert.rejects(
            () => client.controlPlane('GET', '/snapshots/x'),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_TIMEOUT
        );
    });

    await runTest('6. malformed auth result', () => {
        const missingToken = resolveControlPlaneAuth({
            provider: () => ({
                ok: true,
                instanceUrl: 'https://control-org.example.invalid'
            })
        });
        assert.strictEqual(missingToken.ok, false);
        assert.strictEqual(
            missingToken.error.code,
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
        );

        const notObject = resolveControlPlaneAuth({
            provider: () => 'token'
        });
        assert.strictEqual(notObject.ok, false);
        assert.strictEqual(
            notObject.error.code,
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
        );
    });

    const artifactId =
        'snapshots/snapshot_1/destination-before/ApexClass/AccountService';

    await runTest('7-14. artifact upload download exists metadata round-trip hashes', async () => {
        const { httpRequest, calls } = createMockHttp(createArtifactRouter());
        const store = createSalesforceControlPlaneSnapshotBlobStore({
            client: createClient(httpRequest)
        });

        const crlf = Buffer.from('line-one\r\nline-two\r\n');
        const lf = Buffer.from('line-one\nline-two\n');
        const binary = Buffer.from([0x00, 0x01, 0xff, 0x0a, 0x0d]);
        const large = Buffer.alloc(64 * 1024, 0x7a);
        const samples = [
            ['crlf', crlf],
            ['lf', lf],
            ['binary', binary],
            ['large', large]
        ];

        for (const [label, bytes] of samples) {
            const id = `snapshots/snapshot_1/destination-before/ApexClass/${label}`;
            const beforeHash = hashBytes(bytes);
            const put = await store.putArtifact({ artifactId: id, bytes });
            assert.strictEqual(put.artifactId, id);
            assert.strictEqual(put.size, bytes.length);

            const exists = await store.exists(id);
            assert.strictEqual(exists, true);

            const metadata = await store.getMetadata(id);
            assert.deepStrictEqual(metadata, { artifactId: id, size: bytes.length });

            const downloaded = await store.getArtifact(id);
            assert.ok(Buffer.isBuffer(downloaded));
            assert.deepStrictEqual(downloaded, bytes);
            assert.strictEqual(hashBytes(downloaded), beforeHash);
        }

        await assert.rejects(
            () => store.putArtifact({ artifactId, bytes: Buffer.alloc(0) }),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
        );

        const jsonParsed = calls.filter(
            (call) =>
                call.method === 'GET' &&
                call.responseType === 'arraybuffer' &&
                !String(call.url).endsWith('/metadata') &&
                !String(call.url).endsWith('/exists')
        );
        assert.ok(jsonParsed.length >= 4);
        assert.ok(
            calls.some(
                (call) =>
                    call.method === 'POST' &&
                    call.contentType === 'application/octet-stream'
            )
        );
    });

    await runTest('15. cross-snapshot rejection', async () => {
        const { httpRequest } = createMockHttp(createArtifactRouter());
        const store = createSalesforceControlPlaneSnapshotBlobStore({
            client: createClient(httpRequest)
        });
        const owned =
            'snapshots/snapshot_a/destination-before/ApexClass/AccountService';
        await store.putArtifact({
            artifactId: owned,
            bytes: Buffer.from('owned-by-a')
        });

        const client = createClient(httpRequest);
        await assert.rejects(
            () =>
                client.controlPlaneBinary(
                    'GET',
                    `/snapshots/snapshot_b/artifacts/${encodeURIComponent(owned)}`
                ),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
        );

        const other =
            'snapshots/snapshot_b/destination-before/ApexClass/AccountService';
        assert.strictEqual(await store.exists(other), false);
        assert.strictEqual(await store.getArtifact(other), null);
    });

    await runTest('16. sealed artifact overwrite rejection', async () => {
        const sealedSnapshots = new Set();
        const { httpRequest } = createMockHttp(
            createArtifactRouter({ sealedSnapshots })
        );
        const store = createSalesforceControlPlaneSnapshotBlobStore({
            client: createClient(httpRequest)
        });
        await store.putArtifact({
            artifactId,
            bytes: Buffer.from('before-seal')
        });
        sealedSnapshots.add('snapshot_1');
        await assert.rejects(
            () =>
                store.putArtifact({
                    artifactId,
                    bytes: Buffer.from('after-seal')
                }),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT
        );
        const kept = await store.getArtifact(artifactId);
        assert.deepStrictEqual(kept, Buffer.from('before-seal'));
    });

    await runTest('17. path traversal rejection', async () => {
        const { httpRequest, calls } = createMockHttp(createArtifactRouter());
        const store = createSalesforceControlPlaneSnapshotBlobStore({
            client: createClient(httpRequest)
        });
        await assert.rejects(
            () =>
                store.putArtifact({
                    artifactId: 'snapshots/../etc/destination-before/ApexClass/A',
                    bytes: Buffer.from('nope')
                }),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
        );
        assert.strictEqual(calls.length, 0);
    });

    await runTest('18. secret sanitization', async () => {
        const { httpRequest } = createMockHttp(() =>
            fail(
                400,
                'INVALID_REQUEST',
                'Authorization: Bearer super-secret-token accessToken=abc'
            )
        );
        const store = createSalesforceControlPlaneSnapshotBlobStore({
            client: createClient(httpRequest)
        });
        await assert.rejects(
            () =>
                store.putArtifact({
                    artifactId,
                    bytes: Buffer.from('x')
                }),
            (error) => {
                assert.ok(!error.message.includes('super-secret-token'));
                assert.ok(!error.message.includes('abc'));
                return error instanceof ControlPlaneError;
            }
        );
        assert.strictEqual(
            sanitizeControlPlaneText('Bearer abc.def'),
            'Bearer [REDACTED]'
        );
    });

    await runTest('19-24. history create get update list snapshot and job correlation', async () => {
        const records = new Map();
        const { httpRequest } = createMockHttp((config) => {
            const url = String(config.url);
            const method = String(config.method || 'GET').toUpperCase();
            const parsed = new URL(url);
            const historyPart = parsed.pathname.split('/deployment-history')[1] || '';
            const historyId = decodeURIComponent(historyPart.replace(/^\//, '') || '');

            if (method === 'POST') {
                const stored = historySfRecord({
                    Backend_History_Id__c: config.body.historyId,
                    Snapshot_Id__c: config.body.snapshotId,
                    Rollback_Of_History_Id__c: config.body.rollbackOfHistoryId,
                    Deployment_ID__c: config.body.deploymentId
                });
                records.set(stored.Backend_History_Id__c, stored);
                return {
                    status: 200,
                    data: { success: true, recordId: stored.Id }
                };
            }

            if (method === 'PATCH') {
                const current = records.get(historyId);
                if (!current) {
                    return fail(404, 'NOT_FOUND', 'Deployment history not found.');
                }
                const updated = {
                    ...current,
                    Deployment_Status__c: config.body.status || current.Deployment_Status__c
                };
                records.set(historyId, updated);
                return { status: 200, data: { success: true, record: updated, recordId: updated.Id } };
            }

            const snapshotId =
                parsed.searchParams.get('snapshotId') ||
                (config.params && config.params.snapshotId);
            const salesforceDeploymentId =
                parsed.searchParams.get('salesforceDeploymentId') ||
                (config.params && config.params.salesforceDeploymentId);

            if (method === 'GET' && historyId) {
                const current = records.get(historyId);
                if (!current) {
                    return fail(404, 'NOT_FOUND', 'Deployment history not found.');
                }
                return { status: 200, data: { success: true, record: current, recordId: current.Id } };
            }

            if (method === 'GET' && snapshotId) {
                const match = [...records.values()].find(
                    (row) => row.Snapshot_Id__c === snapshotId
                );
                if (!match) {
                    return fail(404, 'NOT_FOUND', 'Deployment history not found.');
                }
                return { status: 200, data: { success: true, record: match, recordId: match.Id } };
            }

            if (method === 'GET' && salesforceDeploymentId) {
                const match = [...records.values()].find(
                    (row) => row.Deployment_ID__c === salesforceDeploymentId
                );
                if (!match) {
                    return fail(404, 'NOT_FOUND', 'Deployment history not found.');
                }
                return { status: 200, data: { success: true, record: match, recordId: match.Id } };
            }

            if (method === 'GET') {
                return {
                    status: 200,
                    data: { success: true, records: [...records.values()] }
                };
            }

            return fail(400, 'INVALID_REQUEST', 'Unknown history route.');
        });
        const store = createSalesforceControlPlaneDeploymentHistoryStore({
            client: createClient(httpRequest)
        });

        const created = await store.create({
            historyId: 'hist-001',
            snapshotId: 'snapshot_1',
            rollbackOfHistoryId: 'hist-000',
            deploymentId: '0AfJOB1',
            accessToken: 'should-not-persist'
        });
        assert.strictEqual(created.historyId, 'hist-001');
        assert.strictEqual(created.accessToken, undefined);

        const loaded = await store.get('hist-001');
        assert.strictEqual(loaded.historyId, 'hist-001');
        assert.strictEqual(loaded.snapshotId, 'snapshot_1');
        assert.strictEqual(loaded.rollbackOfHistoryId, 'hist-000');
        assert.strictEqual(loaded.salesforceDeploymentId, '0AfJOB1');

        const updated = await store.update('hist-001', {
            historyId: 'hist-001',
            status: 'FAILED',
            snapshotId: 'snapshot_1',
            deploymentId: '0AfJOB1'
        });
        assert.strictEqual(updated.status, 'FAILED');

        const listed = await store.list();
        assert.strictEqual(listed.length, 1);

        const bySnapshot = await store.findBySnapshotId('snapshot_1');
        assert.strictEqual(bySnapshot.historyId, 'hist-001');

        const byJob = await store.findBySalesforceDeploymentId('0AfJOB1');
        assert.strictEqual(byJob.historyId, 'hist-001');
        assert.strictEqual(await store.findBySnapshotId('missing'), null);
    });

    await runTest('25. first rollback operation', async () => {
        const { httpRequest } = createMockHttp(() => ok(operationRecord()));
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(httpRequest)
        });
        const created = await store.createOperation({
            operationId: 'rbo-1',
            destinationOrgId: '00Ddest',
            snapshotId: 'snapshot_1',
            rollbackScopeKey: '00Ddest::snapshot_1'
        });
        assert.strictEqual(created.operationId, 'rbo-1');
        assert.strictEqual(created.status, 'NOT_STARTED');
    });

    await runTest('26. FAILED retry same scope is blocked by unique Rollback_Scope_Key__c', async () => {
        assert.strictEqual(CONTROL_PLANE_SCHEMA_DECISIONS.failedRetryScope.status, 'STOP');
        assert.strictEqual(CONTROL_PLANE_SCHEMA_DECISIONS.failedRetryScope.implemented, false);

        const state = { record: operationRecord({ Status__c: 'FAILED' }) };
        const { httpRequest } = createMockHttp((config) => {
            if (String(config.method).toUpperCase() === 'POST' &&
                String(config.url).endsWith('/operations')) {
                return fail(409, 'DUPLICATE_VALUE', 'Duplicate value rejected.', {
                    field: 'Rollback_Scope_Key__c'
                });
            }
            if (String(config.method).toUpperCase() === 'GET') {
                return ok(state.record);
            }
            return fail(400, 'INVALID_REQUEST', 'unexpected');
        });
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(httpRequest)
        });
        await assert.rejects(
            () =>
                store.createOperation({
                    operationId: 'rbo-2',
                    destinationOrgId: '00Ddest',
                    snapshotId: 'snapshot_1',
                    rollbackScopeKey: '00Ddest::snapshot_1',
                    retryOfOperationId: 'rbo-1'
                }),
            /Duplicate rollback scope rejected/
        );
    });

    await runTest('27. SUCCEEDED protection', async () => {
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(async (config) => {
                if (String(config.method).toUpperCase() === 'GET') {
                    return ok(operationRecord({ Status__c: 'SUCCEEDED' }));
                }
                return fail(409, 'INVALID_STATE', 'Cannot transition');
            })
        });
        await assert.rejects(
            () => store.updateOperation('rbo-1', { status: 'FAILED' }),
            /Status transition rejected/
        );
    });

    await runTest('28. UNKNOWN_RESULT protection', async () => {
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(async (config) => {
                if (String(config.method).toUpperCase() === 'GET') {
                    return ok(operationRecord({ Status__c: 'UNKNOWN_RESULT' }));
                }
                return fail(400, 'INVALID_REQUEST', 'should not reconcile');
            })
        });
        await assert.rejects(
            () =>
                store.updateOperation(
                    'rbo-1',
                    { status: 'FAILED' },
                    { allowReconciliation: true }
                ),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH ||
                /Status transition rejected/.test(error.message)
        );
        await assert.rejects(
            () =>
                store.updateOperation('rbo-1', { status: 'FAILED' }),
            /Status transition rejected/
        );
    });

    await runTest('29. concurrent same scope', async () => {
        let created = false;
        const { httpRequest } = createMockHttp(() => {
            if (created) {
                return fail(409, 'DUPLICATE_VALUE', 'Duplicate value rejected.', {
                    field: 'Rollback_Scope_Key__c'
                });
            }
            created = true;
            return ok(operationRecord());
        });
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(httpRequest)
        });
        const first = await store.createOperation({
            operationId: 'rbo-1',
            destinationOrgId: '00Ddest',
            snapshotId: 'snapshot_1',
            rollbackScopeKey: '00Ddest::snapshot_1'
        });
        assert.strictEqual(first.operationId, 'rbo-1');
        await assert.rejects(
            () =>
                store.createOperation({
                    operationId: 'rbo-2',
                    destinationOrgId: '00Ddest',
                    snapshotId: 'snapshot_1',
                    rollbackScopeKey: '00Ddest::snapshot_1'
                }),
            /Duplicate rollback scope rejected/
        );
    });

    await runTest('30. retry history cannot be persisted until schema decision', () => {
        assert.ok(
            CONTROL_PLANE_SCHEMA_DECISIONS.failedRetryScope.decisionRequired.includes(
                'Active_Scope_Key__c'
            )
        );
        assert.strictEqual(
            CONTROL_PLANE_SCHEMA_DECISIONS.failedRetryScope.field,
            'Rollback_Operation__c.Rollback_Scope_Key__c'
        );
    });

    await runTest('31-36. lock concurrency owner generation heartbeat release no auto-steal', async () => {
        const locks = new Map();

        const { httpRequest } = createMockHttp((config) => {
            const method = String(config.method || 'GET').toUpperCase();
            const url = String(config.url);
            const body = config.body || {};

            if (url.endsWith('/locks/acquire')) {
                const current = locks.get(body.destinationOrgId);
                if (current && current.Status__c === 'HELD') {
                    return fail(409, 'CONFLICT', 'Destination org lock is already held.', {
                        leaseGeneration: current.Lease_Generation__c,
                        record: current
                    });
                }
                const generation = current
                    ? Number(current.Lease_Generation__c || 0) + 1
                    : 1;
                const row = lockRecord({
                    Destination_Org_Id__c: body.destinationOrgId,
                    Owner_Id__c: body.ownerId,
                    Operation_Type__c: body.operationType,
                    Status__c: 'HELD',
                    Lease_Generation__c: generation
                });
                locks.set(body.destinationOrgId, row);
                return ok(row, { leaseGeneration: generation });
            }

            if (url.endsWith('/locks/renew')) {
                const current = locks.get(body.destinationOrgId);
                if (
                    !current ||
                    current.Owner_Id__c !== body.ownerId ||
                    Number(current.Lease_Generation__c) !== Number(body.leaseGeneration)
                ) {
                    return fail(409, 'CONFLICT', 'Lease generation or owner does not match.');
                }
                current.Last_Heartbeat_At__c = '2026-08-26T06:01:00.000Z';
                return ok(current, { leaseGeneration: current.Lease_Generation__c });
            }

            if (url.endsWith('/locks/release')) {
                const current = locks.get(body.destinationOrgId);
                if (
                    !current ||
                    current.Owner_Id__c !== body.ownerId ||
                    Number(current.Lease_Generation__c) !== Number(body.leaseGeneration)
                ) {
                    return fail(409, 'CONFLICT', 'Lease generation or owner does not match.');
                }
                current.Status__c = 'RELEASED';
                return ok(current, { leaseGeneration: current.Lease_Generation__c });
            }

            if (method === 'GET') {
                const destinationOrgId = decodeURIComponent(url.split('/locks/')[1] || '');
                const current = locks.get(destinationOrgId);
                if (!current) {
                    return fail(404, 'NOT_FOUND', 'Lock not found.');
                }
                return ok(current, { leaseGeneration: current.Lease_Generation__c });
            }

            return fail(400, 'INVALID_REQUEST', 'Unknown lock route.');
        });

        const store = createSalesforceControlPlaneOrgLockStore({
            client: createClient(httpRequest)
        });

        const [deployA, deployB] = await Promise.allSettled([
            store.acquire({
                destinationOrgId: '00Dsame',
                ownerId: 'owner-1',
                operationType: 'DEPLOY'
            }),
            store.acquire({
                destinationOrgId: '00Dsame',
                ownerId: 'owner-2',
                operationType: 'DEPLOY'
            })
        ]);
        const held = [deployA, deployB].filter((result) => result.status === 'fulfilled');
        const busy = [deployA, deployB].filter((result) => result.status === 'rejected');
        assert.strictEqual(held.length, 1);
        assert.strictEqual(busy.length, 1);
        assert.ok(busy[0].reason instanceof OrgLockBusyError);

        await assert.rejects(
            () =>
                store.acquire({
                    destinationOrgId: '00Dsame',
                    ownerId: 'owner-3',
                    operationType: 'ROLLBACK'
                }),
            OrgLockBusyError
        );

        const otherA = await store.acquire({
            destinationOrgId: '00Dother',
            ownerId: 'owner-9',
            operationType: 'ROLLBACK'
        });
        const otherB = await store.acquire({
            destinationOrgId: '00Dthird',
            ownerId: 'owner-8',
            operationType: 'ROLLBACK'
        });
        assert.strictEqual(otherA.status, 'HELD');
        assert.strictEqual(otherB.status, 'HELD');

        await assert.rejects(
            () =>
                store.renew({
                    destinationOrgId: '00Dsame',
                    ownerId: held[0].value.ownerId,
                    leaseGeneration: 99
                }),
            OrgLockOwnershipError
        );

        const heartbeat = await store.renew({
            destinationOrgId: '00Dsame',
            ownerId: held[0].value.ownerId,
            leaseGeneration: held[0].value.leaseGeneration
        });
        assert.ok(heartbeat.lastHeartbeatAt);

        const released = await store.release({
            destinationOrgId: '00Dsame',
            ownerId: held[0].value.ownerId,
            leaseGeneration: held[0].value.leaseGeneration
        });
        assert.strictEqual(released.status, 'RELEASED');

        const stolen = await Promise.allSettled([
            store.acquire({
                destinationOrgId: '00Dheld2',
                ownerId: 'owner-a',
                operationType: 'DEPLOY'
            }),
            store.acquire({
                destinationOrgId: '00Dheld2',
                ownerId: 'owner-b',
                operationType: 'ROLLBACK'
            })
        ]);
        assert.strictEqual(
            stolen.filter((result) => result.status === 'fulfilled').length,
            1
        );
        assert.ok(
            stolen.find((result) => result.status === 'rejected').reason instanceof
                OrgLockBusyError
        );

        assert.strictEqual(LOCK_PRODUCTION_DISTRIBUTED_READY, false);
        assert.strictEqual(LOCK_MULTI_REPLICA_PROOF.status, 'UNPROVEN');
        assert.strictEqual(LOCK_MULTI_REPLICA_PROOF.productionDistributedReady, false);
    });

    await runTest('37. CONTROL_ORG does not fallback to filesystem', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r74-control-org-'));
        try {
            assert.strictEqual(
                resolveControlPlaneStorageMode({
                    SNAPSHOT_STORAGE_MODE: 'CONTROL_ORG',
                    SNAPSHOT_DURABLE_ROOT: root
                }),
                CONTROL_ORG_MODE
            );
            const { httpRequest } = createMockHttp(() => ({
                status: 500,
                data: { success: false, code: 'INVALID_REQUEST', message: 'boom' }
            }));
            const store = createSalesforceControlPlaneSnapshotBlobStore({
                client: createClient(httpRequest)
            });
            await assert.rejects(
                () =>
                    store.putArtifact({
                        artifactId,
                        bytes: Buffer.from('x')
                    }),
                ControlPlaneError
            );
            assert.deepStrictEqual(fs.readdirSync(root), []);
            assert.strictEqual(LOCK_PRODUCTION_DISTRIBUTED_READY, false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await runTest('38. MEMORY unchanged', () => {
        assert.strictEqual(resolveControlPlaneStorageMode({}), 'MEMORY');
        assert.strictEqual(
            resolveControlPlaneStorageMode({ SNAPSHOT_STORAGE_MODE: 'MEMORY' }),
            'MEMORY'
        );
    });

    await runTest('39. FILESYSTEM unchanged', () => {
        assert.strictEqual(
            resolveControlPlaneStorageMode({ SNAPSHOT_STORAGE_MODE: 'DURABLE' }),
            'DURABLE'
        );
    });
})();
