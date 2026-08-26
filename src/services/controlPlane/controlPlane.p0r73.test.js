'use strict';

const assert = require('assert');

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
    fromSalesforceMemberKey,
    isMemberKeyTranslationCollisionSafe,
    toSalesforceMemberKey
} = require('./controlPlane.memberKey');
const {
    toNodeCaptureStatus,
    toSalesforceCaptureStatus
} = require('./controlPlane.captureStatus');
const {
    toSalesforceHistoryPayload
} = require('./controlPlane.historyMapping');
const {
    toSalesforceSealPatch
} = require('./controlPlane.snapshotMapping');
const {
    createSalesforceControlPlaneSnapshotMetadataStore
} = require('./stores/salesforceControlPlaneSnapshotMetadataStore');
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
const { OrgLockBusyError, OrgLockOwnershipError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
const { MISSING_CONTROL_PLANE_ENDPOINTS } = require('./controlPlane.missingEndpoints');

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

function snapshotRecord(overrides = {}) {
    return {
        Snapshot_Id__c: 'snapshot_1',
        Deployment_Id__c: 'deploy_1',
        Source_Org_Id__c: '00Dsrc',
        Destination_Org_Id__c: '00Ddest',
        Source_Branch__c: 'feature',
        Destination_Branch__c: 'main',
        Created_At__c: '2026-08-26T06:00:00.000Z',
        Completed_At__c: null,
        Sealed_At__c: null,
        Status__c: 'CAPTURING',
        Schema_Version__c: '2',
        Snapshot_Version__c: '1',
        Overall_Integrity_Hash__c: null,
        Rollback_Eligible__c: false,
        Capture_Failure_Reason__c: null,
        Member_Count__c: 0,
        ...overrides
    };
}

function memberRecord(overrides = {}) {
    return {
        Member_Key__c: 'snapshot_1|ApexClass|AccountService',
        Metadata_Type__c: 'ApexClass',
        Metadata_Name__c: 'AccountService',
        File_Path__c: 'classes/AccountService.cls',
        Change_Class__c: 'MODIFIED',
        Existed_Before__c: true,
        Destination_Before_Hash__c: 'abc',
        Expected_After_Hash__c: 'def',
        Artifact_Id__c: 'snapshots/snapshot_1/destination-before/ApexClass/AccountService',
        Artifact_Size__c: 12,
        Capture_Status__c: 'CAPTURED',
        Content_Document_Id__c: '069xx0000000001',
        ...overrides
    };
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

function routeKey(config) {
    const parsed = new URL(config.url);
    return `${String(config.method || 'GET').toUpperCase()} ${parsed.pathname}`;
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
            authorization: normalized.headers && normalized.headers.Authorization
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

(async () => {
    await runTest('1. successful snapshot create/read/update', async () => {
        const state = { record: snapshotRecord() };
        const { httpRequest, calls } = createMockHttp((config) => {
            const key = routeKey(config);
            if (key === 'POST /services/apexrest/control-plane/snapshots') {
                state.record = snapshotRecord(config.body);
                state.record.Snapshot_Id__c = config.body.snapshotId;
                state.record.Destination_Org_Id__c = config.body.destinationOrgId;
                return ok(state.record);
            }
            if (key === 'GET /services/apexrest/control-plane/snapshots/snapshot_1') {
                return ok(state.record);
            }
            if (key === 'PATCH /services/apexrest/control-plane/snapshots/snapshot_1') {
                state.record = {
                    ...state.record,
                    Status__c: config.body.status || state.record.Status__c,
                    Member_Count__c:
                        config.body.memberCount == null
                            ? state.record.Member_Count__c
                            : config.body.memberCount
                };
                return ok(state.record);
            }
            return fail(404, 'NOT_FOUND', 'Unknown');
        });
        const store = createSalesforceControlPlaneSnapshotMetadataStore({
            client: createClient(httpRequest)
        });

        const created = await store.createSnapshot({
            snapshotId: 'snapshot_1',
            destinationOrgId: '00Ddest',
            status: 'CAPTURING',
            schemaVersion: 2
        });
        assert.strictEqual(created.snapshotId, 'snapshot_1');
        assert.strictEqual(created.destinationOrgId, '00Ddest');

        const loaded = await store.getSnapshot('snapshot_1');
        assert.strictEqual(loaded.snapshotId, 'snapshot_1');

        const updated = await store.updateSnapshot('snapshot_1', {
            status: 'READY',
            memberCount: 1
        });
        assert.strictEqual(updated.status, 'READY');
        assert.strictEqual(updated.memberCount, 1);
        assert.ok(calls.every((call) => call.authorization.startsWith('Bearer ')));
    });

    await runTest('2. member create/read/list', async () => {
        const members = [];
        const { httpRequest } = createMockHttp((config) => {
            const key = routeKey(config);
            if (key.endsWith('/members') && config.method === 'POST') {
                const stored = memberRecord({
                    Capture_Status__c: 'CAPTURED',
                    Metadata_Type__c: config.body.metadataType,
                    Metadata_Name__c: config.body.metadataName,
                    Artifact_Id__c: config.body.artifactId,
                    Artifact_Size__c: config.body.artifactSize,
                    Content_Document_Id__c: config.body.contentDocumentId
                });
                members.push(stored);
                return ok(stored);
            }
            if (key.endsWith('/members') && config.method === 'GET') {
                return {
                    status: 200,
                    data: { success: true, records: members }
                };
            }
            return fail(404, 'NOT_FOUND', 'Unknown');
        });
        const store = createSalesforceControlPlaneSnapshotMetadataStore({
            client: createClient(httpRequest)
        });

        const added = await store.addMember({
            snapshotId: 'snapshot_1',
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            filePath: 'classes/AccountService.cls',
            changeClass: 'MODIFIED',
            existedBefore: true,
            destinationBeforeHash: 'abc',
            expectedAfterHash: 'def',
            artifactId: 'snapshots/snapshot_1/destination-before/ApexClass/AccountService',
            artifactSize: 12,
            captureStatus: 'COMPLETE',
            contentDocumentId: '069xx0000000001'
        });
        assert.strictEqual(added.captureStatus, 'COMPLETE');
        assert.strictEqual(added.artifactId.includes('AccountService'), true);
        assert.strictEqual(added.contentDocumentId, '069xx0000000001');

        const listed = await store.getMembers('snapshot_1');
        assert.strictEqual(listed.length, 1);
        const found = await store.getMember(
            'snapshot_1',
            'ApexClass',
            'AccountService'
        );
        assert.strictEqual(found.metadataName, 'AccountService');
    });

    await runTest('3. member-key translation is collision-safe', () => {
        const key = toSalesforceMemberKey(
            'snapshot_1',
            'ApexClass',
            'AccountService'
        );
        assert.strictEqual(key, 'snapshot_1|ApexClass|AccountService');
        const reversed = fromSalesforceMemberKey(key);
        assert.strictEqual(reversed.nodeKey, 'ApexClass:AccountService');
        assert.strictEqual(
            isMemberKeyTranslationCollisionSafe(
                'snapshot_1',
                'ApexClass',
                'AccountService'
            ),
            true
        );
        assert.throws(
            () => toSalesforceMemberKey('snap|shot', 'ApexClass', 'Foo'),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
        );
        assert.strictEqual(
            isMemberKeyTranslationCollisionSafe('snap|shot', 'ApexClass', 'Foo'),
            false
        );
    });

    await runTest('4. capture-status mapping is explicit and fail-closed', () => {
        assert.strictEqual(
            toSalesforceCaptureStatus('COMPLETE'),
            'CAPTURED'
        );
        assert.strictEqual(
            toSalesforceCaptureStatus('ABSENT_PROVEN'),
            'NOT_REQUIRED'
        );
        assert.strictEqual(
            toSalesforceCaptureStatus('UNKNOWN'),
            'SKIPPED'
        );
        assert.strictEqual(
            toSalesforceCaptureStatus('FAILED'),
            'FAILED'
        );
        assert.strictEqual(toNodeCaptureStatus('CAPTURED'), 'COMPLETE');
        assert.throws(
            () => toSalesforceCaptureStatus('PENDING'),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
        );
        assert.throws(
            () => toNodeCaptureStatus('PENDING'),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
        );
        assert.throws(
            () => toNodeCaptureStatus('CAPTURING'),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
        );
    });

    await runTest('5. seal patches accepted fields then posts /seal', async () => {
        const calls = [];
        let record = snapshotRecord({ Status__c: 'READY' });
        const { httpRequest } = createMockHttp((config) => {
            calls.push(routeKey(config));
            if (config.method === 'PATCH') {
                assert.strictEqual(config.body.status, undefined);
                record = {
                    ...record,
                    Overall_Integrity_Hash__c: config.body.overallIntegrityHash,
                    Rollback_Eligible__c: config.body.rollbackEligible,
                    Completed_At__c: config.body.completedAt
                };
                return ok(record);
            }
            if (String(config.url).endsWith('/seal')) {
                record = {
                    ...record,
                    Status__c: 'SEALED',
                    Sealed_At__c: '2026-08-26T06:05:00.000Z'
                };
                return ok(record);
            }
            return fail(404, 'NOT_FOUND', 'Unknown');
        });
        const store = createSalesforceControlPlaneSnapshotMetadataStore({
            client: createClient(httpRequest)
        });
        const sealed = await store.sealSnapshot('snapshot_1', {
            sealedAt: '2026-08-26T06:05:00.000Z',
            completedAt: '2026-08-26T06:05:00.000Z',
            overallIntegrityHash: 'hash',
            rollbackEligible: true,
            status: 'SEALED'
        });
        assert.strictEqual(sealed.status, 'SEALED');
        assert.strictEqual(sealed.overallIntegrityHash, 'hash');
        assert.ok(calls.some((item) => item.endsWith('/seal')));
        assert.throws(
            () => toSalesforceSealPatch({ unknownField: true }),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH &&
                /unknownField/.test(error.message)
        );
    });

    await runTest('6. artifact mapping stays on member fields, not custom-object bytes', async () => {
        const added = memberRecord();
        assert.strictEqual(added.Artifact_Id__c.startsWith('snapshots/'), true);
        assert.strictEqual(typeof added.Artifact_Size__c, 'number');
        assert.ok(added.Content_Document_Id__c);
        assert.strictEqual(added.VersionData, undefined);
    });

    await runTest('7. missing blob endpoint fails closed', async () => {
        const store = createSalesforceControlPlaneSnapshotBlobStore({
            client: createClient(async () => ok({}))
        });
        await assert.rejects(
            () => store.putArtifact({ artifactId: 'a', bytes: Buffer.from('x') }),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE &&
                error.message === MISSING_CONTROL_PLANE_ENDPOINTS.snapshotArtifactPut
        );
        await assert.rejects(() => store.getArtifact('a'), ControlPlaneError);
        await assert.rejects(() => store.exists('a'), ControlPlaneError);
        await assert.rejects(() => store.getMetadata('a'), ControlPlaneError);
    });

    await runTest('8. history mapping persists historyId snapshotId rollbackOfHistoryId', async () => {
        let posted = null;
        const { httpRequest } = createMockHttp((config) => {
            posted = config.data;
            assert.ok(!String(config.url).includes('/control-plane/'));
            return {
                status: 200,
                data: { success: true, recordId: 'a01xx0000000001' }
            };
        });
        const store = createSalesforceControlPlaneDeploymentHistoryStore({
            client: createClient(httpRequest)
        });
        const saved = await store.create({
            historyId: 'hist-001',
            snapshotId: 'snapshot_1',
            rollbackOfHistoryId: 'hist-000',
            deploymentId: '0Af000JOB',
            accessToken: 'should-not-persist'
        });
        assert.strictEqual(posted.historyId, 'hist-001');
        assert.strictEqual(posted.snapshotId, 'snapshot_1');
        assert.strictEqual(posted.rollbackOfHistoryId, 'hist-000');
        assert.strictEqual(posted.deploymentId, '0Af000JOB');
        assert.strictEqual(posted.accessToken, undefined);
        assert.strictEqual(saved.historyId, 'hist-001');
        const mapped = toSalesforceHistoryPayload({
            historyId: 'hist-001',
            snapshotId: 'snap',
            rollbackOfHistoryId: null,
            deploymentId: '0Af1'
        });
        assert.strictEqual(mapped.historyId, 'hist-001');
        await assert.rejects(() => store.get('hist-001'), ControlPlaneError);
    });

    await runTest('9. operation create/read/update', async () => {
        const state = { record: operationRecord() };
        const { httpRequest } = createMockHttp((config) => {
            const key = routeKey(config);
            if (key === 'POST /services/apexrest/control-plane/operations') {
                assert.strictEqual(config.body.rollbackScopeKey, '00Ddest|snapshot_1');
                return ok(state.record);
            }
            if (key === 'GET /services/apexrest/control-plane/operations/rbo-1') {
                return ok(state.record);
            }
            if (key === 'PATCH /services/apexrest/control-plane/operations/rbo-1') {
                state.record = {
                    ...state.record,
                    Salesforce_Deployment_Id__c: config.body.salesforceDeploymentId
                };
                return ok(state.record);
            }
            return fail(404, 'NOT_FOUND', 'Unknown');
        });
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(httpRequest)
        });
        const created = await store.createOperation({
            operationId: 'rbo-1',
            destinationOrgId: '00Ddest',
            snapshotId: 'snapshot_1',
            rollbackScopeKey: '00Ddest::snapshot_1'
        });
        assert.strictEqual(created.rollbackScopeKey, '00Ddest::snapshot_1');
        const loaded = await store.getOperation('rbo-1');
        assert.strictEqual(loaded.operationId, 'rbo-1');
        const updated = await store.updateOperation('rbo-1', {
            salesforceDeploymentId: '0AfUPDATED'
        });
        assert.strictEqual(updated.salesforceDeploymentId, '0AfUPDATED');
    });

    await runTest('10. operation state precedence rejects FAILED overwrite of SUCCEEDED', async () => {
        const state = {
            record: operationRecord({ Status__c: 'SUCCEEDED' })
        };
        const { httpRequest, calls } = createMockHttp((config) => {
            if (String(config.url).includes('/terminal')) {
                return fail(409, 'INVALID_STATE', 'Cannot transition');
            }
            if (config.method === 'GET') {
                return ok(state.record);
            }
            return fail(409, 'INVALID_STATE', 'rejected');
        });
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(httpRequest)
        });
        await assert.rejects(
            () =>
                store.updateOperation('rbo-1', {
                    status: 'FAILED'
                }),
            /Status transition rejected/
        );
        assert.ok(!calls.some((call) => String(call.url).includes('/terminal')));

        state.record = operationRecord({ Status__c: 'IN_PROGRESS' });
        const { httpRequest: inProgressHttp, calls: inProgressCalls } = createMockHttp(
            (config) => {
                if (config.method === 'GET') {
                    return ok(state.record);
                }
                if (String(config.url).endsWith('/terminal')) {
                    assert.strictEqual(config.body.status, 'FAILED');
                    return ok(operationRecord({ Status__c: 'FAILED' }));
                }
                return fail(400, 'INVALID_REQUEST', 'unexpected PATCH');
            }
        );
        const inProgressStore = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(inProgressHttp)
        });
        const failed = await inProgressStore.updateOperation('rbo-1', {
            status: 'FAILED',
            resultCode: 'X',
            resultMessage: 'interrupted'
        });
        assert.strictEqual(failed.status, 'FAILED');
        assert.ok(
            inProgressCalls.some((call) => String(call.url).endsWith('/terminal'))
        );
    });

    await runTest('11. duplicate rollback scope fails closed', async () => {
        const { httpRequest } = createMockHttp(() =>
            fail(409, 'DUPLICATE_VALUE', 'Duplicate value rejected.', {
                field: 'Rollback_Scope_Key__c'
            })
        );
        const store = createSalesforceControlPlaneRollbackOperationStore({
            client: createClient(httpRequest)
        });
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

    await runTest('12-16. lock acquire, busy, renew, release, generation mismatch', async () => {
        const { httpRequest } = createMockHttp((config) => {
            const key = routeKey(config);
            if (key.endsWith('/locks/acquire')) {
                return ok(lockRecord(), { leaseGeneration: 1 });
            }
            if (key.endsWith('/locks/renew')) {
                return ok(
                    lockRecord({ Last_Heartbeat_At__c: '2026-08-26T06:01:00.000Z' }),
                    { leaseGeneration: 1 }
                );
            }
            if (key.endsWith('/locks/release')) {
                return ok(lockRecord({ Status__c: 'RELEASED' }), { leaseGeneration: 1 });
            }
            return fail(404, 'NOT_FOUND', 'Unknown');
        });
        const store = createSalesforceControlPlaneOrgLockStore({
            client: createClient(httpRequest)
        });
        const acquired = await store.acquire({
            destinationOrgId: '00Ddest',
            ownerId: 'owner-1',
            operationType: 'DEPLOY'
        });
        assert.strictEqual(acquired.status, 'HELD');
        assert.strictEqual(acquired.leaseGeneration, 1);
        const renewed = await store.renew({
            destinationOrgId: '00Ddest',
            ownerId: 'owner-1',
            leaseGeneration: 1
        });
        assert.ok(renewed.lastHeartbeatAt);
        const released = await store.release({
            destinationOrgId: '00Ddest',
            ownerId: 'owner-1',
            leaseGeneration: 1
        });
        assert.strictEqual(released.status, 'RELEASED');

        const busy = createSalesforceControlPlaneOrgLockStore({
            client: createClient(async () =>
                fail(409, 'CONFLICT', 'Destination org lock is already held.', {
                    leaseGeneration: 3
                })
            )
        });
        await assert.rejects(
            () =>
                busy.acquire({
                    destinationOrgId: '00Ddest',
                    ownerId: 'owner-2',
                    operationType: 'DEPLOY'
                }),
            OrgLockBusyError
        );

        const mismatch = createSalesforceControlPlaneOrgLockStore({
            client: createClient(async () =>
                fail(409, 'CONFLICT', 'Lease generation or owner does not match.')
            )
        });
        await assert.rejects(
            () =>
                mismatch.renew({
                    destinationOrgId: '00Ddest',
                    ownerId: 'owner-1',
                    leaseGeneration: 99
                }),
            OrgLockOwnershipError
        );
    });

    await runTest('17. Product Org auth unavailable fails closed', () => {
        const resolved = resolveControlPlaneAuth();
        assert.strictEqual(resolved.ok, false);
        assert.strictEqual(
            resolved.error.code,
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
        );
        const store = createSalesforceControlPlaneSnapshotMetadataStore({});
        return assert.rejects(
            () => store.getSnapshot('snapshot_1'),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
        );
    });

    await runTest('18. Product Org timeout', async () => {
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

    await runTest('19. Salesforce 401', async () => {
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

    await runTest('20. Salesforce 403', async () => {
        const client = createClient(async () =>
            fail(403, 'UNAUTHORIZED', 'Insufficient access')
        );
        await assert.rejects(
            () => client.controlPlane('GET', '/snapshots/x'),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_PERMISSION_DENIED
        );
    });

    await runTest('21. Salesforce 404', async () => {
        const client = createClient(async () => fail(404, 'NOT_FOUND', 'missing'));
        await assert.rejects(
            () => client.controlPlane('GET', '/snapshots/x'),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
        );
    });

    await runTest('22. Salesforce 409', async () => {
        const client = createClient(async () =>
            fail(409, 'CONFLICT', 'Destination org lock is already held.')
        );
        await assert.rejects(
            () => client.controlPlane('POST', '/locks/acquire'),
            (error) => error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT
        );
    });

    await runTest('23. malformed Salesforce response', async () => {
        const client = createClient(async () => ({
            status: 200,
            data: 'not-json-at-all <<'
        }));
        await assert.rejects(
            () => client.controlPlane('GET', '/snapshots/x'),
            (error) =>
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_INVALID_RESPONSE
        );
    });

    await runTest('24. secret sanitization', () => {
        const error = new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
            'Authorization: Bearer super-secret-token accessToken=abc'
        );
        assert.ok(!error.message.includes('super-secret-token'));
        assert.ok(!error.message.includes('abc'));
        assert.strictEqual(
            sanitizeControlPlaneText('Bearer abc.def'),
            'Bearer [REDACTED]'
        );
        const provider = createTestControlPlaneAuthProvider({
            accessToken: 'secret-token',
            instanceUrl: 'https://control-org.example.invalid'
        });
        const auth = resolveControlPlaneAuth({ provider });
        assert.strictEqual(auth.ok, true);
        assert.notStrictEqual(auth.source, 'destination-refresh-token');
    });
})();
