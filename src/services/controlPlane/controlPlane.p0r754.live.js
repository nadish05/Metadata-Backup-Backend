'use strict';

/**
 * P0-R7.5.4 live Node ↔ Product Org adapter verification.
 * Uses the existing sf CLI session for alias agentforceOrg.
 * Does not change production resolveControlPlaneAuth().
 * Does not enable rollback or distributed lock readiness.
 *
 * Run: node src/services/controlPlane/controlPlane.p0r754.live.js
 */

const { execFile } = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');
const axios = require('axios');

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');
const {
    createTestControlPlaneAuthProvider,
    resolveControlPlaneAuth
} = require('./controlPlane.auth');
const { createSalesforceControlPlaneClient } = require('./controlPlane.client');
const {
    createSalesforceControlPlaneRollbackOperationStore
} = require('./stores/salesforceControlPlaneRollbackOperationStore');
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
    createSalesforceControlPlaneOrgLockStore
} = require('./stores/salesforceControlPlaneOrgLockStore');
const { OrgLockBusyError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
const { LOCK_PRODUCTION_DISTRIBUTED_READY } = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    CONTROL_ORG_MODE,
    isControlOrgLockStore,
    resolveControlPlaneStorageMode
} = require('./controlPlane.mode');

const execFileAsync = promisify(execFile);

let sfBin = process.platform === 'win32' ? 'sf.cmd' : 'sf';
let restSession = null;

const ORG_ALIAS = 'agentforceOrg';
const EXPECTED_ORG_ID = '00DNS00000sYkXa2AK';
const DEST = 'P0-R754-TEST-DEST';
const SNAP = 'P0-R754-TEST-SNAPSHOT';
const OP1 = 'P0-R754-OP-1';
const OP2 = 'P0-R754-OP-2';
const HIST = 'P0-R754-HIST-1';
const LOCK_DEST = 'P0-R754-LOCK-DEST';
const ARTIFACT_ID = `snapshots/${SNAP}/destination-before/ApexClass/P0R754Live`;
const ARTIFACT_BYTES = Buffer.from([0x00, 0x01, 0xff, 0x0a, 0x0d]);

const results = [];

function record(name, result, evidence, notes) {
    results.push({ name, result, evidence, notes });
    const mark = result === 'PASS' ? 'PASS' : result;
    console.log(`${mark}: ${name} — ${evidence}`);
    if (notes) {
        console.log(`  notes: ${notes}`);
    }
}

function failClosed(name, error) {
    record(
        name,
        'FAIL',
        error && error.code ? String(error.code) : 'exception',
        String(error && error.message ? error.message : error)
    );
}

async function resolveSfBin() {
    if (process.platform !== 'win32') {
        return 'sf';
    }

    return 'sf.cmd';
}

function quoteCmdArg(value) {
    const text = String(value);
    if (!/[\s&<>|^()"]/.test(text)) {
        return text;
    }

    return `"${text.replace(/"/g, '""')}"`;
}

async function sfJson(args) {
    const options = {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
    };
    try {
        const { stdout } =
            process.platform === 'win32'
                ? await execFileAsync(
                      'cmd.exe',
                      ['/c', 'sf', ...args.map(quoteCmdArg)],
                      options
                  )
                : await execFileAsync(sfBin, args, options);
        return JSON.parse(stdout);
    } catch (error) {
        const stdout = String(error.stdout || '');
        let parsed = null;
        try {
            parsed = JSON.parse(stdout);
        } catch (parseError) {
            void parseError;
        }
        const message = parsed && parsed.message
            ? parsed.message
            : 'sf command failed';
        throw new Error(message);
    }
}

function redactOrgDisplay(parsed) {
    const result = parsed && parsed.result ? parsed.result : {};
    return {
        alias: result.alias || ORG_ALIAS,
        orgId: result.id || result.orgId || null,
        instanceUrl: result.instanceUrl || null,
        username: result.username ? '[redacted-username]' : null,
        hasAccessToken: Boolean(result.accessToken)
    };
}

async function queryRecords(soql) {
    if (!restSession) {
        throw new Error('Product Org REST session is not available.');
    }

    const response = await axios.get(
        `${restSession.instanceUrl}/services/data/v62.0/query`,
        {
            params: { q: soql },
            headers: {
                Authorization: `Bearer ${restSession.accessToken}`
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );

    if (response.status >= 400) {
        const body = response.data;
        const message =
            (Array.isArray(body) && body[0] && body[0].message) ||
            (body && body.message) ||
            `SOQL failed with HTTP ${response.status}`;
        throw new Error(message);
    }

    return (response.data && response.data.records) || [];
}

async function deleteRecord(sobject, id) {
    if (!id || !restSession) {
        return;
    }

    const response = await axios.delete(
        `${restSession.instanceUrl}/services/data/v62.0/sobjects/${encodeURIComponent(
            sobject
        )}/${encodeURIComponent(id)}`,
        {
            headers: {
                Authorization: `Bearer ${restSession.accessToken}`
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );

    if (response.status >= 400 && response.status !== 404) {
        throw new Error(`Delete ${sobject} failed with HTTP ${response.status}`);
    }
}

function hashBytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function cleanupSyntheticRecords() {
    const opRows = await queryRecords(
        "SELECT Id, Operation_Id__c FROM Rollback_Operation__c WHERE Operation_Id__c LIKE 'P0-R754-%'"
    );
    for (const row of opRows) {
        await deleteRecord('Rollback_Operation__c', row.Id);
    }

    const histRows = await queryRecords(
        "SELECT Id FROM Deployment_History__c WHERE Backend_History_Id__c = 'P0-R754-HIST-1'"
    );
    for (const row of histRows) {
        await deleteRecord('Deployment_History__c', row.Id);
    }

    const lockRows = await queryRecords(
        "SELECT Id FROM Destination_Org_Lock__c WHERE Destination_Org_Id__c = 'P0-R754-LOCK-DEST'"
    );
    for (const row of lockRows) {
        await deleteRecord('Destination_Org_Lock__c', row.Id);
    }

    const memberRows = await queryRecords(
        "SELECT Id, Content_Document_Id__c FROM Deployment_Snapshot_Member__c WHERE Artifact_Id__c = 'snapshots/P0-R754-TEST-SNAPSHOT/destination-before/ApexClass/P0R754Live'"
    );
    const documentIds = new Set(
        memberRows.map((row) => row.Content_Document_Id__c).filter(Boolean)
    );
    const versionRows = await queryRecords(
        "SELECT ContentDocumentId FROM ContentVersion WHERE Description LIKE 'control-plane-artifact|P0-R754-TEST-SNAPSHOT|%' AND IsLatest = true"
    );
    for (const row of versionRows) {
        if (row.ContentDocumentId) {
            documentIds.add(row.ContentDocumentId);
        }
    }
    for (const row of memberRows) {
        await deleteRecord('Deployment_Snapshot_Member__c', row.Id);
    }
    for (const docId of documentIds) {
        try {
            await deleteRecord('ContentDocument', docId);
        } catch (error) {
            void error;
        }
    }

    const snapRows = await queryRecords(
        "SELECT Id FROM Deployment_Snapshot__c WHERE Snapshot_Id__c = 'P0-R754-TEST-SNAPSHOT'"
    );
    for (const row of snapRows) {
        await deleteRecord('Deployment_Snapshot__c', row.Id);
    }

    const leftoverOps = await queryRecords(
        "SELECT Operation_Id__c FROM Rollback_Operation__c WHERE Operation_Id__c LIKE 'P0-R754-%'"
    );
    const leftoverSnaps = await queryRecords(
        "SELECT Snapshot_Id__c FROM Deployment_Snapshot__c WHERE Snapshot_Id__c = 'P0-R754-TEST-SNAPSHOT'"
    );
    const leftoverHist = await queryRecords(
        "SELECT Backend_History_Id__c FROM Deployment_History__c WHERE Backend_History_Id__c = 'P0-R754-HIST-1'"
    );
    const leftoverLocks = await queryRecords(
        "SELECT Destination_Org_Id__c FROM Destination_Org_Lock__c WHERE Destination_Org_Id__c = 'P0-R754-LOCK-DEST'"
    );

    return {
        leftoverOps,
        leftoverSnaps,
        leftoverHist,
        leftoverLocks
    };
}

(async () => {
    const created = {
        operations: [],
        snapshots: [],
        history: [],
        locks: [],
        contentDocuments: []
    };

    let client;
    let operations;
    let snapshots;
    let blobs;
    let history;
    let locks;

    try {
        sfBin = await resolveSfBin();

        const productionAuth = resolveControlPlaneAuth();
        if (
            productionAuth.ok === false &&
            productionAuth.error &&
            productionAuth.error.code ===
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
        ) {
            record(
                'production auth remains fail-closed',
                'PASS',
                'CONTROL_PLANE_AUTH_UNAVAILABLE without provider',
                'Production resolveControlPlaneAuth() unchanged'
            );
        } else {
            record(
                'production auth remains fail-closed',
                'FAIL',
                'production auth unexpectedly available',
                ''
            );
        }

        const rollbackEnabled = ['1', 'true', 'yes', 'on'].includes(
            String(process.env.SNAPSHOT_ROLLBACK_ENABLED || '')
                .trim()
                .toLowerCase()
        );
        if (rollbackEnabled) {
            record(
                'rollback flag remains off',
                'FAIL',
                'SNAPSHOT_ROLLBACK_ENABLED is true',
                ''
            );
        } else {
            record(
                'rollback flag remains off',
                'PASS',
                'SNAPSHOT_ROLLBACK_ENABLED default false',
                ''
            );
        }

        if (LOCK_PRODUCTION_DISTRIBUTED_READY === false) {
            record(
                'distributed lock readiness remains false',
                'PASS',
                'LOCK_PRODUCTION_DISTRIBUTED_READY=false',
                'This phase does not prove multi-replica readiness'
            );
        } else {
            record(
                'distributed lock readiness remains false',
                'FAIL',
                'LOCK_PRODUCTION_DISTRIBUTED_READY is true',
                ''
            );
        }

        const display = await sfJson(['org', 'display', '--target-org', ORG_ALIAS, '--json']);
        const session = display.result || {};
        const safeDisplay = redactOrgDisplay(display);
        console.log(
            `Product Org session: orgId=${safeDisplay.orgId} instanceUrl=${safeDisplay.instanceUrl} hasAccessToken=${safeDisplay.hasAccessToken}`
        );

        if (!session.accessToken || !session.instanceUrl) {
            record(
                'Product Org CLI session',
                'BLOCKED',
                'sf org display missing token or instanceUrl',
                JSON.stringify(safeDisplay)
            );
            throw new Error('BLOCKED: Product Org CLI session unavailable');
        }

        if (String(session.id || session.orgId || '').slice(0, 15) !== EXPECTED_ORG_ID.slice(0, 15)) {
            record(
                'Product Org CLI session',
                'FAIL',
                `unexpected org id ${String(session.id || session.orgId || '').slice(0, 15)}`,
                'Expected 00DNS00000sYkXa2AK'
            );
        } else {
            record(
                'Product Org CLI session',
                'PASS',
                `alias=${ORG_ALIAS} orgId=${EXPECTED_ORG_ID}`,
                'Used existing sf CLI session; token not logged'
            );
        }

        restSession = {
            accessToken: session.accessToken,
            instanceUrl: session.instanceUrl
        };

        const provider = createTestControlPlaneAuthProvider({
            accessToken: session.accessToken,
            instanceUrl: session.instanceUrl
        });
        const auth = resolveControlPlaneAuth({ provider });
        client = createSalesforceControlPlaneClient({
            accessToken: auth.accessToken,
            instanceUrl: auth.instanceUrl,
            timeoutMs: 30000
        });
        operations = createSalesforceControlPlaneRollbackOperationStore({ client });
        snapshots = createSalesforceControlPlaneSnapshotMetadataStore({ client });
        blobs = createSalesforceControlPlaneSnapshotBlobStore({ client });
        history = createSalesforceControlPlaneDeploymentHistoryStore({ client });
        locks = createSalesforceControlPlaneOrgLockStore({ client });

        await cleanupSyntheticRecords();

        const createdOp = await operations.createOperation({
            operationId: OP1,
            destinationOrgId: DEST,
            snapshotId: SNAP,
            rollbackScopeKey: `${DEST}::${SNAP}`
        });
        created.operations.push(OP1);

        const createdOk =
            createdOp.operationId === OP1 &&
            createdOp.status === 'NOT_STARTED' &&
            createdOp.rollbackScopeKey === `${DEST}::${SNAP}` &&
            createdOp.activeScopeKey === `${DEST}::${SNAP}` &&
            createdOp.destinationOrgId === DEST &&
            createdOp.snapshotId === SNAP;
        record(
            'live operation create',
            createdOk ? 'PASS' : 'FAIL',
            `operationId=${createdOp.operationId} status=${createdOp.status} activeScopeKey=${createdOp.activeScopeKey}`,
            `rollbackScopeKey=${createdOp.rollbackScopeKey}`
        );

        const sfOps = await queryRecords(
            "SELECT Operation_Id__c, Status__c, Destination_Org_Id__c, Snapshot_Id__c, Rollback_Scope_Key__c, Active_Scope_Key__c, Retry_Of_Operation_Id__c FROM Rollback_Operation__c WHERE Operation_Id__c = 'P0-R754-OP-1'"
        );
        const sfOp = sfOps[0] || {};
        const sfCreateOk =
            sfOp.Operation_Id__c === OP1 &&
            sfOp.Status__c === 'NOT_STARTED' &&
            sfOp.Active_Scope_Key__c === `${DEST}|${SNAP}` &&
            sfOp.Rollback_Scope_Key__c === `${DEST}|${SNAP}`;
        record(
            'Salesforce independent create verify',
            sfCreateOk ? 'PASS' : 'FAIL',
            `Status__c=${sfOp.Status__c} Active_Scope_Key__c=${sfOp.Active_Scope_Key__c}`,
            ''
        );

        let duplicateCode = null;
        try {
            await operations.createOperation({
                operationId: 'P0-R754-OP-DUP',
                destinationOrgId: DEST,
                snapshotId: SNAP,
                rollbackScopeKey: `${DEST}::${SNAP}`
            });
            record(
                'live duplicate fencing',
                'FAIL',
                'second create succeeded',
                'Adapter must not convert 409 into success'
            );
        } catch (error) {
            duplicateCode = error.code;
            const conflict =
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT;
            record(
                'live duplicate fencing',
                conflict ? 'PASS' : 'FAIL',
                String(error.code),
                error.field ? `field=${error.field}` : error.message
            );
        }

        const stillFirst = await operations.getOperation(OP1);
        record(
            'original operation intact after duplicate',
            stillFirst && stillFirst.status === 'NOT_STARTED' && stillFirst.operationId === OP1
                ? 'PASS'
                : 'FAIL',
            stillFirst ? `status=${stillFirst.status}` : 'missing',
            ''
        );

        const inProgress = await operations.updateOperation(OP1, {
            status: 'IN_PROGRESS'
        });
        const failed = await operations.updateOperation(OP1, {
            status: 'FAILED',
            resultCode: 'P0_R754',
            resultMessage: 'synthetic failed transition'
        });
        const failedReread = await operations.getOperation(OP1);
        const failedOk =
            failed.status === 'FAILED' &&
            failed.rollbackScopeKey === `${DEST}::${SNAP}` &&
            (failed.activeScopeKey == null || failed.activeScopeKey === undefined) &&
            failedReread.status === 'FAILED' &&
            failedReread.activeScopeKey == null;
        record(
            'live FAILED transition',
            failedOk ? 'PASS' : 'FAIL',
            `status=${failed.status} activeScopeKey=${failed.activeScopeKey}`,
            `inProgressWas=${inProgress.status}`
        );

        const sfFailed = (
            await queryRecords(
                "SELECT Status__c, Rollback_Scope_Key__c, Active_Scope_Key__c FROM Rollback_Operation__c WHERE Operation_Id__c = 'P0-R754-OP-1'"
            )
        )[0] || {};
        record(
            'Salesforce independent FAILED verify',
            sfFailed.Status__c === 'FAILED' &&
                sfFailed.Rollback_Scope_Key__c === `${DEST}|${SNAP}` &&
                sfFailed.Active_Scope_Key__c == null
                ? 'PASS'
                : 'FAIL',
            `Status__c=${sfFailed.Status__c} Active_Scope_Key__c=${sfFailed.Active_Scope_Key__c}`,
            `Rollback_Scope_Key__c=${sfFailed.Rollback_Scope_Key__c}`
        );

        const retry = await operations.createOperation({
            operationId: OP2,
            destinationOrgId: DEST,
            snapshotId: SNAP,
            rollbackScopeKey: `${DEST}::${SNAP}`,
            retryOfOperationId: OP1
        });
        created.operations.push(OP2);
        const retryOk =
            retry.operationId === OP2 &&
            retry.retryOfOperationId === OP1 &&
            retry.status === 'NOT_STARTED' &&
            retry.activeScopeKey === `${DEST}::${SNAP}`;
        record(
            'live retry after FAILED',
            retryOk ? 'PASS' : 'FAIL',
            `operationId=${retry.operationId} retryOf=${retry.retryOfOperationId} status=${retry.status}`,
            `activeScopeKey=${retry.activeScopeKey}`
        );

        const historical = await operations.findByDestinationAndSnapshot(DEST, SNAP);
        const statuses = historical.map((row) => `${row.operationId}:${row.status}`).sort();
        const historicalOk =
            historical.length === 2 &&
            historical.some((row) => row.operationId === OP1 && row.status === 'FAILED') &&
            historical.some((row) => row.operationId === OP2 && row.status === 'NOT_STARTED');
        record(
            'live historical query',
            historicalOk ? 'PASS' : 'FAIL',
            `count=${historical.length} ${statuses.join(',')}`,
            'Must not latest-wins / LIMIT 1'
        );

        const snapshot = await snapshots.createSnapshot({
            snapshotId: SNAP,
            deploymentId: 'P0-R754-DEP',
            sourceOrgId: 'P0-R754-SRC',
            destinationOrgId: DEST,
            sourceBranch: 'feature/p0-r754',
            destinationBranch: 'main',
            status: 'CAPTURING',
            schemaVersion: 2,
            snapshotVersion: 1,
            overallIntegrityHash: 'abc123',
            rollbackEligible: false,
            captureFailureReason: null,
            memberCount: 0
        });
        created.snapshots.push(SNAP);
        const loadedSnap = await snapshots.getSnapshot(SNAP);
        const snapOk =
            loadedSnap.snapshotId === SNAP &&
            loadedSnap.deploymentId === 'P0-R754-DEP' &&
            loadedSnap.sourceOrgId === 'P0-R754-SRC' &&
            loadedSnap.destinationOrgId === DEST &&
            loadedSnap.sourceBranch === 'feature/p0-r754' &&
            loadedSnap.destinationBranch === 'main' &&
            loadedSnap.schemaVersion === 2 &&
            loadedSnap.snapshotVersion === 1 &&
            loadedSnap.overallIntegrityHash === 'abc123' &&
            loadedSnap.rollbackEligible === false &&
            loadedSnap.memberCount === 0 &&
            Boolean(loadedSnap.createdAt);
        record(
            'live snapshot metadata round-trip',
            snapOk ? 'PASS' : 'FAIL',
            `snapshotId=${loadedSnap.snapshotId} status=${loadedSnap.status} createdAt=${loadedSnap.createdAt}`,
            `createStatus=${snapshot.status}`
        );

        const beforeHash = hashBytes(ARTIFACT_BYTES);
        const put = await blobs.putArtifact({
            artifactId: ARTIFACT_ID,
            bytes: ARTIFACT_BYTES
        });
        if (put.contentDocumentId) {
            created.contentDocuments.push(put.contentDocumentId);
        }
        const exists = await blobs.exists(ARTIFACT_ID);
        const metadata = await blobs.getMetadata(ARTIFACT_ID);
        const downloaded = await blobs.getArtifact(ARTIFACT_ID);
        const afterHash = hashBytes(downloaded);
        const artifactOk =
            exists === true &&
            Buffer.isBuffer(downloaded) &&
            downloaded.equals(ARTIFACT_BYTES) &&
            beforeHash === afterHash &&
            metadata &&
            metadata.size === ARTIFACT_BYTES.length;
        record(
            'live artifact round-trip',
            artifactOk ? 'PASS' : 'FAIL',
            `size=${metadata && metadata.size} hashMatch=${beforeHash === afterHash}`,
            `putSize=${put.size}`
        );

        let historyResult = 'BLOCKED';
        let historyNotes = '';
        try {
            const createdHist = await history.create({
                historyId: HIST,
                snapshotId: SNAP,
                rollbackOfHistoryId: null,
                deploymentId: 'P0R754JOB001',
                deploymentMode: 'VALIDATE',
                executionMode: 'check-only',
                status: 'SUCCESS',
                validationStatus: 'PASS'
            });
            created.history.push(HIST);
            const got = await history.get(HIST);
            const patched = await history.update(HIST, {
                historyId: HIST,
                snapshotId: SNAP,
                deploymentId: 'P0R754JOB001',
                status: 'FAILED'
            });
            const listed = await history.list();
            const bySnap = await history.findBySnapshotId(SNAP);
            const byJob = await history.findBySalesforceDeploymentId('P0R754JOB001');
            const historyOk =
                createdHist.historyId === HIST &&
                got &&
                got.historyId === HIST &&
                got.snapshotId === SNAP &&
                patched &&
                patched.status === 'FAILED' &&
                Array.isArray(listed) &&
                listed.some((row) => row.historyId === HIST) &&
                bySnap &&
                bySnap.historyId === HIST &&
                byJob &&
                byJob.historyId === HIST;
            historyResult = historyOk ? 'PASS' : 'FAIL';
            historyNotes = `get.snapshotId=${got && got.snapshotId} patched.status=${patched && patched.status}`;
            record('live history adapter', historyResult, `historyId=${HIST}`, historyNotes);
        } catch (error) {
            historyResult = /required|relationship|INVALID/i.test(String(error.message))
                ? 'BLOCKED'
                : 'FAIL';
            record(
                'live history adapter',
                historyResult,
                error.code || 'exception',
                error.message
            );
        }

        let busyOk = false;
        try {
            const acquired = await locks.acquire({
                destinationOrgId: LOCK_DEST,
                ownerId: 'P0-R754-OWNER',
                operationType: 'DEPLOY'
            });
            created.locks.push(LOCK_DEST);
        try {
            await locks.acquire({
                destinationOrgId: LOCK_DEST,
                ownerId: 'P0-R754-OWNER-2',
                operationType: 'ROLLBACK'
            });
        } catch (error) {
            busyOk = error instanceof OrgLockBusyError;
        }
        const heartbeat = await locks.renew({
            destinationOrgId: LOCK_DEST,
            ownerId: 'P0-R754-OWNER',
            leaseGeneration: acquired.leaseGeneration
        });
        const released = await locks.release({
            destinationOrgId: LOCK_DEST,
            ownerId: 'P0-R754-OWNER',
            leaseGeneration: acquired.leaseGeneration
        });
        const acquiredAgain = await locks.acquire({
            destinationOrgId: LOCK_DEST,
            ownerId: 'P0-R754-OWNER-3',
            operationType: 'ROLLBACK'
        });
        await locks.release({
            destinationOrgId: LOCK_DEST,
            ownerId: 'P0-R754-OWNER-3',
            leaseGeneration: acquiredAgain.leaseGeneration
        });
        const lockOk =
            acquired.status === 'HELD' &&
            busyOk &&
            Boolean(heartbeat.lastHeartbeatAt) &&
            released.status === 'RELEASED' &&
            acquiredAgain.status === 'HELD' &&
            acquiredAgain.leaseGeneration !== acquired.leaseGeneration;
        record(
            'live lock adapter',
            lockOk ? 'PASS' : 'FAIL',
            `gen1=${acquired.leaseGeneration} gen2=${acquiredAgain.leaseGeneration} busy=${busyOk}`,
            'Does not prove multi-replica readiness'
        );
        } catch (error) {
            failClosed('live lock adapter', error);
        }

        try {
            await client.controlPlane(
                'GET',
                `/operations/${encodeURIComponent('P0-R754-MISSING')}`
            );
            record('error mapping 404', 'FAIL', 'missing GET succeeded', '');
        } catch (error) {
            const storeMiss = await operations.getOperation('P0-R754-MISSING');
            record(
                'error mapping 404',
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND &&
                    storeMiss == null
                    ? 'PASS'
                    : 'FAIL',
                String(error.code),
                `storeGet=${storeMiss == null ? 'null' : 'present'}`
            );
        }

        record(
            'error mapping 409 conflict/busy',
            duplicateCode === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT && busyOk
                ? 'PASS'
                : 'FAIL',
            `duplicate=${duplicateCode} lockBusy=${busyOk}`,
            ''
        );

        try {
            await operations.createOperation({
                destinationOrgId: DEST,
                snapshotId: SNAP
            });
            record('error mapping invalid request', 'FAIL', 'blank operationId succeeded', '');
        } catch (error) {
            record(
                'error mapping invalid request',
                error instanceof ControlPlaneError &&
                    (error.salesforceCode === 'INVALID_REQUEST' ||
                        error.code ===
                            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE)
                    ? 'PASS'
                    : 'FAIL',
                String(error.code),
                `salesforceCode=${error.salesforceCode || ''}`
            );
        }

        try {
            await blobs.putArtifact({
                artifactId: 'snapshots/../etc/destination-before/ApexClass/A',
                bytes: Buffer.from('x')
            });
            record('error mapping schema mismatch', 'FAIL', 'path traversal succeeded', '');
        } catch (error) {
            record(
                'error mapping schema mismatch',
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
                    ? 'PASS'
                    : 'FAIL',
                String(error.code),
                ''
            );
        }

        const authUnavailable = resolveControlPlaneAuth();
        record(
            'error mapping auth unavailable',
            authUnavailable.ok === false &&
                authUnavailable.error.code ===
                    CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE
                ? 'PASS'
                : 'FAIL',
            String(authUnavailable.error && authUnavailable.error.code),
            ''
        );

        const storageMode = resolveControlPlaneStorageMode({
            SNAPSHOT_STORAGE_MODE: 'CONTROL_ORG',
            SNAPSHOT_DURABLE_ROOT: 'C:\\tmp\\should-not-use'
        });
        const lockControlOrg = isControlOrgLockStore({
            DEPLOYMENT_LOCK_STORE: 'CONTROL_ORG',
            DEPLOYMENT_LOCK_ROOT: 'C:\\tmp\\should-not-use'
        });
        record(
            'CONTROL_ORG does not fallback',
            storageMode === CONTROL_ORG_MODE && lockControlOrg === true
                ? 'PASS'
                : 'FAIL',
            `storage=${storageMode} lockControlOrg=${lockControlOrg}`,
            ''
        );
    } catch (error) {
        if (!String(error.message || '').startsWith('BLOCKED:')) {
            failClosed('live harness', error);
        }
    } finally {
        try {
            const leftover = await cleanupSyntheticRecords();
            const clean =
                leftover.leftoverOps.length === 0 &&
                leftover.leftoverSnaps.length === 0 &&
                leftover.leftoverHist.length === 0 &&
                leftover.leftoverLocks.length === 0;
            record(
                'synthetic cleanup',
                clean ? 'PASS' : 'FAIL',
                `ops=${leftover.leftoverOps.length} snaps=${leftover.leftoverSnaps.length} hist=${leftover.leftoverHist.length} locks=${leftover.leftoverLocks.length}`,
                'Deleted only P0-R754-* synthetic records'
            );
        } catch (error) {
            record(
                'synthetic cleanup',
                'FAIL',
                error.code || 'exception',
                error.message
            );
        }

        console.log('\n| Test | Result | Evidence | Notes |');
        console.log('|------|--------|----------|-------|');
        for (const row of results) {
            console.log(
                `| ${row.name} | ${row.result} | ${row.evidence} | ${row.notes || ''} |`
            );
        }

        const blocking = results.filter((row) => row.result === 'BLOCKED');
        const failing = results.filter((row) => row.result === 'FAIL');
        if (failing.length) {
            console.log(
                `\nP0-R7.5.4 FAIL — ${failing.map((row) => row.name).join(', ')}`
            );
            process.exitCode = 1;
        } else if (blocking.length) {
            console.log(
                `\nP0-R7.5.4 BLOCKED — ${blocking.map((row) => row.name).join(', ')}`
            );
            process.exitCode = 2;
        } else {
            console.log(
                '\nP0-R7.5.4 PASS — LIVE NODE ↔ SALESFORCE CONTROL PLANE VERIFIED'
            );
        }
    }
})().catch((error) => {
    console.error('FAIL: live harness crashed');
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
});
