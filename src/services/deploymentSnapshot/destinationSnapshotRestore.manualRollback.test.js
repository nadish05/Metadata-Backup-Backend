'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    EXPECTED_AFTER_REPRESENTATION
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const { createSnapshotCaptureService } = require('./snapshotCapture.service');
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
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const {
    createRollbackAuthorizationService
} = require('./rollbackAuthorization.service');
const {
    createTestRollbackAuthorizationProvider,
    createTestTrustedActor
} = require('./rollbackAuthorization.testProvider');
const {
    buildRecordTypeSemanticFromWorkspaceArtifact
} = require('./recordTypeSemanticExpectedAfter.service');
const { REASON_CODE } = require('./rollbackMemberExecutionPolicy.service');
const {
    createDeploymentRollbackAsyncService
} = require('../deploymentRollbackAsync.service');
const {
    createRollbackOperationService
} = require('./rollbackOperation.service');
const { ROLLBACK_OPERATION_STATUS } = require('./rollbackOperation.types');

const RECORD_TYPE_PATH =
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml';

const RECORD_TYPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise_Deal</fullName>
    <active>true</active>
    <businessProcess>New Sales Process</businessProcess>
    <label>Enterprise Deal</label>
    <picklistValues>
        <picklist>Customer_Field__c</picklist>
        <values><fullName>Event</fullName><default>false</default></values>
    </picklistValues>
</RecordType>`;

const RECORD_TYPE_XML_OTHER_PROCESS = RECORD_TYPE_XML.replace(
    'New Sales Process',
    'Unrelated Process'
);

const RAW_B =
    '7ecc23ef2efce4421e04a5af4e2a5c767ce0ab1903945b40bebbf0f98cd9273a';

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

function recordTypeArtifact(xml = RECORD_TYPE_XML) {
    return packMemberFiles([
        {
            relativePath: RECORD_TYPE_PATH,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

function newDeleteMember(overrides = {}) {
    const artifact = recordTypeArtifact(overrides.recordTypeXml);
    const built = buildRecordTypeSemanticFromWorkspaceArtifact(
        artifact,
        'Opportunity.Enterprise_Deal'
    );

    return {
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal',
        filePath: RECORD_TYPE_PATH,
        changeClass: CHANGE_CLASS.NEW,
        captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
        existedBefore: false,
        expectedAfterHash: RAW_B,
        expectedAfterRepresentation:
            EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1,
        canonicalExpectedAfterHash: built.canonicalHash,
        recordTypeSemanticCaptureSpec: built.captureSpec,
        ...overrides.memberOverrides
    };
}

function businessProcessArtifact(processName = 'New Sales Process') {
    return packMemberFiles([
        {
            relativePath: `force-app/main/default/objects/Opportunity/businessProcesses/${processName}.businessProcess-meta.xml`,
            bytes: Buffer.from('<BusinessProcess/>', 'utf8')
        }
    ]);
}

function businessProcessDeleteMember(metadataName = 'Opportunity.New Sales Process') {
    const artifactBytes = businessProcessArtifact(
        metadataName.split('.')[1]
    );

    return {
        metadataType: 'BusinessProcess',
        metadataName,
        filePath: `force-app/main/default/objects/Opportunity/businessProcesses/${metadataName.split('.')[1]}.businessProcess-meta.xml`,
        changeClass: CHANGE_CLASS.NEW,
        captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
        existedBefore: false,
        expectedAfterHash: hashBytes(artifactBytes)
    };
}

function modifiedApexMember() {
    const before = packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/SomeClass.cls',
            bytes: Buffer.from('public class SomeClass {}\n', 'utf8')
        },
        {
            relativePath: 'force-app/main/default/classes/SomeClass.cls-meta.xml',
            bytes: Buffer.from(
                '<?xml version="1.0" encoding="UTF-8"?>\n',
                'utf8'
            )
        }
    ]);
    const after = packMemberFiles([
        {
            relativePath: 'force-app/main/default/classes/SomeClass.cls',
            bytes: Buffer.from('public class SomeClass { /* after */ }\n', 'utf8')
        },
        {
            relativePath: 'force-app/main/default/classes/SomeClass.cls-meta.xml',
            bytes: Buffer.from(
                '<?xml version="1.0" encoding="UTF-8"?>\n',
                'utf8'
            )
        }
    ]);

    return {
        metadataType: 'ApexClass',
        metadataName: 'SomeClass',
        filePath: 'force-app/main/default/classes/SomeClass.cls',
        changeClass: CHANGE_CLASS.MODIFIED,
        captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
        destinationBeforeBytes: before,
        expectedAfterHash: hashBytes(after),
        artifactBytes: before,
        destinationAfterBytes: after
    };
}

async function sealSnapshot(members) {
    const capture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: '00D000000000001',
            sourceOrgId: '00D000000000002'
        },
        members
    });
    return {
        capture,
        sealed: await capture.sealSnapshot(ready.snapshotId)
    };
}

function createRestore({
    capture,
    operationStore: providedOperationStore = null,
    retrieveByMember = () => recordTypeArtifact(),
    buildDeleteRollbackWorkspace: buildDeleteRollbackWorkspaceOverride,
    buildMixedRollbackWorkspace,
    buildRestoreWorkspace: buildRestoreWorkspaceOverride,
    buildRecordTypeSemanticFromDestination,
    inventoryStates = {}
} = {}) {
    let executions = 0;
    let checkOnlyRuns = 0;
    const deleteWorkspaceCalls = [];
    const mixedWorkspaceCalls = [];
    const restoreWorkspaceCalls = [];
    const operationStore =
        providedOperationStore || createMemoryRollbackOperationStore();

    function stubWorkspace(members) {
        return {
            generatedDeploymentPackage: {},
            generatedManifest: {
                version: '61.0',
                types: members.map((member) => ({
                    name: member.metadataType,
                    members: [member.metadataName.split('.').pop()]
                }))
            },
            destructiveChangesPath: null
        };
    }

    const service = createDestinationSnapshotRestoreService({
        captureService: capture,
        getRollbackOperationStore: () => operationStore,
        isSnapshotRollbackEnabled: () => true,
        isDurableSnapshotStorageReady: () => true,
        isDeploymentOrgLockEnabled: () => false,
        getRollbackAuthorizationService: () =>
            createRollbackAuthorizationService({
                provider: createTestRollbackAuthorizationProvider({
                    rollback: true
                })
            }),
        resolveTrustedActor: () => createTestTrustedActor(),
        resolveVerifiedDestinationOrgId: async () => '00D000000000001',
        startLockHeartbeat: () => () => {},
        refreshAccessToken: async () => ({
            accessToken: 'token',
            instanceUrl: 'https://dest.example.com'
        }),
        buildRecordTypeSemanticFromDestination:
            buildRecordTypeSemanticFromDestination ||
            (async ({ destinationArtifactBytes, metadataName }) =>
                buildRecordTypeSemanticFromWorkspaceArtifact(
                    destinationArtifactBytes,
                    metadataName
                )),
        retrieveDestinationMember: async ({ metadataType, metadataName }) => {
            const artifactBytes = retrieveByMember(metadataType, metadataName);
            return { artifactBytes, files: [] };
        },
        buildDeleteRollbackWorkspace: async (args) => {
            deleteWorkspaceCalls.push(args);
            if (buildDeleteRollbackWorkspaceOverride) {
                return buildDeleteRollbackWorkspaceOverride(args);
            }
            return stubWorkspace(args.members);
        },
        buildMixedRollbackWorkspace:
            buildMixedRollbackWorkspace ||
            (async (args) => {
                mixedWorkspaceCalls.push(args);
                return stubWorkspace(args.members);
            }),
        buildRestoreWorkspace: async (args) => {
            restoreWorkspaceCalls.push(args);
            if (buildRestoreWorkspaceOverride) {
                return buildRestoreWorkspaceOverride(args);
            }
            return stubWorkspace(args.members);
        },
        runCheckOnlyDeployment: async () => {
            checkOnlyRuns += 1;
            return {
                executed: true,
                success: true,
                status: 'Succeeded',
                message: 'ok'
            };
        },
        runDeploymentExecution: async () => {
            executions += 1;
            return {
                success: true,
                status: 'Succeeded',
                message: 'deployed',
                deploymentId: '0AfOK'
            };
        },
        buildDestinationInventory: async ({ items }) => ({
            inventory: items.map((item) => ({
                metadataType: item.metadataType,
                metadataName: item.metadataName,
                state:
                    inventoryStates[
                        `${item.metadataType}:${item.metadataName}`
                    ] || 'MISSING'
            }))
        }),
        getState: (inventory, metadataType, metadataName) => {
            const entry = inventory.find(
                (item) =>
                    item.metadataType === metadataType &&
                    item.metadataName === metadataName
            );
            return entry?.state || 'MISSING';
        }
    });

    return {
        service,
        counts: () => ({ executions, checkOnlyRuns }),
        deleteWorkspaceCalls,
        mixedWorkspaceCalls,
        restoreWorkspaceCalls
    };
}

(async () => {
    await runTest('RecordType NEW manual-only skips deployment', async () => {
        const { capture, sealed } = await sealSnapshot([newDeleteMember()]);
        const restore = createRestore({ capture });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.MANUAL_ROLLBACK_REQUIRED);
        assert.strictEqual(result.manualRollbackRequired, true);
        assert.strictEqual(result.partialSuccess, false);
        assert.strictEqual(result.manualRollbackItems.length, 1);
        assert.strictEqual(
            result.manualRollbackItems[0].reasonCode,
            REASON_CODE.RECORDTYPE_DELETE_UNSUPPORTED
        );
        assert.strictEqual(restore.counts().executions, 0);
        assert.strictEqual(restore.counts().checkOnlyRuns, 0);
    });

    await runTest(
        'RecordType NEW and linked BusinessProcess are both manual',
        async () => {
            const { capture, sealed } = await sealSnapshot([
                newDeleteMember(),
                businessProcessDeleteMember()
            ]);
            const restore = createRestore({
                capture,
                retrieveByMember: (metadataType) =>
                    metadataType === 'BusinessProcess'
                        ? businessProcessArtifact()
                        : recordTypeArtifact()
            });
            const result = await restore.service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(
                result.code,
                ROLLBACK_CODE.MANUAL_ROLLBACK_REQUIRED
            );
            assert.strictEqual(result.manualRollbackItems.length, 2);
            assert.strictEqual(restore.counts().executions, 0);
        }
    );

    await runTest(
        'unproven BusinessProcess link remains automatic delete',
        async () => {
            const { capture, sealed } = await sealSnapshot([
                newDeleteMember({ recordTypeXml: RECORD_TYPE_XML_OTHER_PROCESS }),
                businessProcessDeleteMember()
            ]);
            const restore = createRestore({
                capture,
                retrieveByMember: (metadataType) =>
                    metadataType === 'BusinessProcess'
                        ? businessProcessArtifact()
                        : recordTypeArtifact(RECORD_TYPE_XML_OTHER_PROCESS)
            });
            const result = await restore.service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.manualRollbackItems.length, 1);
            assert.strictEqual(restore.counts().executions, 1);
            assert.strictEqual(restore.deleteWorkspaceCalls.length, 1);
            assert.strictEqual(
                restore.deleteWorkspaceCalls[0].members.length,
                1
            );
            assert.strictEqual(
                restore.deleteWorkspaceCalls[0].members[0].metadataType,
                'BusinessProcess'
            );
        }
    );

    await runTest('mixed rollback deploys only automatic members', async () => {
        const { capture, sealed } = await sealSnapshot([
            newDeleteMember(),
            businessProcessDeleteMember(),
            modifiedApexMember()
        ]);
        const restore = createRestore({
            capture,
            retrieveByMember: (metadataType) => {
                if (metadataType === 'ApexClass') {
                    return modifiedApexMember().destinationAfterBytes;
                }
                if (metadataType === 'BusinessProcess') {
                    return businessProcessArtifact();
                }
                return recordTypeArtifact();
            }
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.partialSuccess, true);
        assert.strictEqual(result.manualRollbackRequired, true);
        assert.strictEqual(result.manualRollbackItems.length, 2);
        assert.strictEqual(restore.restoreWorkspaceCalls.length, 1);
        assert.strictEqual(
            restore.restoreWorkspaceCalls[0].members.length,
            1
        );
        assert.strictEqual(
            restore.restoreWorkspaceCalls[0].members[0].metadataType,
            'ApexClass'
        );
    });

    await runTest('supported-only rollback unchanged', async () => {
        const { capture, sealed } = await sealSnapshot([modifiedApexMember()]);
        const restore = createRestore({
            capture,
            retrieveByMember: () => modifiedApexMember().destinationAfterBytes
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.manualRollbackRequired, undefined);
        assert.strictEqual(result.partialSuccess, undefined);
    });

    await runTest('RecordType DRIFTED blocks before partial deployment', async () => {
        const { capture, sealed } = await sealSnapshot([newDeleteMember()]);
        const restore = createRestore({
            capture,
            buildRecordTypeSemanticFromDestination: async () => ({
                canonicalHash:
                    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                captureSpec: {}
            })
        });
        const result = await restore.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.strictEqual(restore.counts().executions, 0);
    });

    await runTest('async polling preserves manual rollback items', async () => {
        const store = createMemoryRollbackOperationStore();
        const operationService = createRollbackOperationService({
            getStore: () => store
        });
        const { capture, sealed } = await sealSnapshot([newDeleteMember()]);
        const restore = createRestore({ capture, operationStore: store });
        const restoreService = restore.service;

        const asyncService = createDeploymentRollbackAsyncService({
            getStore: () => store,
            rollbackOperationService: operationService,
            executeRollback: async (args) => {
                const restoreResult = await restoreService.runRollback({
                    snapshotId: args.snapshotId,
                    refreshToken: args.refreshToken,
                    instanceUrl: args.instanceUrl,
                    operationId: args.operationId
                });
                return {
                    httpStatus: 200,
                    body: {
                        success: restoreResult.success,
                        blocked: restoreResult.blocked,
                        code: restoreResult.code,
                        message: restoreResult.message,
                        operationId: restoreResult.operationId,
                        operationStatus: restoreResult.operationStatus,
                        manualRollbackRequired: restoreResult.manualRollbackRequired,
                        manualRollbackItems: restoreResult.manualRollbackItems,
                        partialSuccess: restoreResult.partialSuccess
                    }
                };
            }
        });

        const started = await asyncService.startRollback({
            historyId: 'history-manual',
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com',
            snapshotId: sealed.snapshotId,
            orgId: '00D000000000001'
        });

        for (let attempt = 0; attempt < 50; attempt += 1) {
            const status = await asyncService.getRollbackStatus(
                started.operationId
            );
            if (
                status.body?.status === ROLLBACK_OPERATION_STATUS.FAILED ||
                status.body?.status === ROLLBACK_OPERATION_STATUS.SUCCEEDED
            ) {
                assert.strictEqual(status.body.result.manualRollbackRequired, true);
                assert.strictEqual(
                    status.body.result.manualRollbackItems[0].reasonCode,
                    REASON_CODE.RECORDTYPE_DELETE_UNSUPPORTED
                );
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        throw new Error('async rollback did not reach terminal status');
    });
})();
