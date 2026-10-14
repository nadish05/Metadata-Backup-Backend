'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
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
const {
    createRollbackOperationService
} = require('./rollbackOperation.service');
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
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    FLOW_POST_DELETE_VERIFICATION_OUTCOME
} = require('../retrieval/flowVersionDiscovery.service');

const FLOW_V4_PATH =
    'force-app/main/default/flows/Check_Amount-4.flow-meta.xml';

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

function flowV4AfterBytes() {
    return packMemberFiles([
        {
            relativePath: FLOW_V4_PATH,
            bytes: Buffer.from('<Flow version="4"/>', 'utf8')
        }
    ]);
}

async function sealFlowV4DeleteSnapshot() {
    const capture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const afterBytes = flowV4AfterBytes();
    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: '00D000000000001',
            sourceOrgId: '00D000000000002'
        },
        members: [
            {
                metadataType: 'Flow',
                metadataName: 'Check_Amount-4',
                filePath: FLOW_V4_PATH,
                changeClass: CHANGE_CLASS.NEW,
                expectedAfterHash: hashBytes(afterBytes)
            }
        ]
    });
    const sealed = await capture.sealSnapshot(ready.snapshotId);

    return { capture, sealed, afterBytes };
}

function buildFlowDeleteRestoreService({
    capture,
    retrieveBytes,
    inventoryState = DESTINATION_STATE.EXISTS,
    verifyFlowPostDeleteAbsence,
    discoverFlowVersionsForPostDeleteVerification
}) {
    const operationStore = createMemoryRollbackOperationStore();

    const serviceOptions = {
        getRollbackOperationStore: () => operationStore,
        rollbackOperationService: createRollbackOperationService({
            getStore: () => operationStore
        }),
        captureService: capture,
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
        retrieveDestinationMember: async () => ({
            artifactBytes: retrieveBytes,
            files: []
        }),
        runCheckOnlyDeployment: async () => ({
            executed: true,
            success: true,
            status: 'Succeeded'
        }),
        runDeploymentExecution: async () => ({
            success: true,
            status: 'Succeeded',
            deploymentId: '0AfFLOWDELETE'
        }),
        refreshAccessToken: async () => ({
            accessToken: 'token',
            instanceUrl: 'https://dest.example.com'
        }),
        buildDestinationInventory: async ({ items }) => ({
            inventory: new Map(
                items.map((item) => [
                    `${item.metadataType}:${item.metadataName}`,
                    { state: inventoryState }
                ])
            )
        })
    };

    if (verifyFlowPostDeleteAbsence) {
        serviceOptions.verifyVersionQualifiedFlowPostDeleteAbsence =
            verifyFlowPostDeleteAbsence;
    }

    if (discoverFlowVersionsForPostDeleteVerification) {
        serviceOptions.discoverFlowVersionsForPostDeleteVerification =
            discoverFlowVersionsForPostDeleteVerification;
    }

    return {
        service: createDestinationSnapshotRestoreService(serviceOptions),
        operationStore
    };
}

function createFlowDeleteHarness(options) {
    const { service } = buildFlowDeleteRestoreService(options);

    return service;
}

function discoveryWithV1Only() {
    return {
        definitions: [{ developerName: 'Check_Amount' }],
        versions: [
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: 1
            }
        ]
    };
}

function discoveryWithV4Present() {
    return {
        definitions: [{ developerName: 'Check_Amount' }],
        versions: [
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: 4
            }
        ]
    };
}

async function sealApexDeleteSnapshot() {
    const capture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const afterBytes = packMemberFiles([
        {
            relativePath:
                'force-app/main/default/classes/DemoDeletedClass.cls',
            bytes: Buffer.from(
                'public class DemoDeletedClass {\n}\n',
                'utf8'
            )
        }
    ]);
    const ready = await capture.captureSnapshot({
        deploymentContext: { destinationOrgId: '00D000000000001' },
        members: [
            {
                metadataType: 'ApexClass',
                metadataName: 'DemoDeletedClass',
                filePath:
                    'force-app/main/default/classes/DemoDeletedClass.cls',
                changeClass: CHANGE_CLASS.NEW,
                expectedAfterHash: hashBytes(afterBytes)
            }
        ]
    });
    const sealed = await capture.sealSnapshot(ready.snapshotId);

    return { capture, sealed, afterBytes };
}

(async () => {
    await runTest(
        'version-qualified Flow passes post-delete when target version absent but definition inventory EXISTS',
        async () => {
            const { capture, sealed, afterBytes } =
                await sealFlowV4DeleteSnapshot();
            const restore = createFlowDeleteHarness({
                capture,
                retrieveBytes: afterBytes,
                inventoryState: DESTINATION_STATE.EXISTS,
                verifyFlowPostDeleteAbsence: async () => ({
                    outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.PASS
                })
            });
            const result = await restore.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.operationStatus, 'SUCCEEDED');
        }
    );

    await runTest(
        'version-qualified Flow fails post-delete when target version still present',
        async () => {
            const { capture, sealed, afterBytes } =
                await sealFlowV4DeleteSnapshot();
            const restore = createFlowDeleteHarness({
                capture,
                retrieveBytes: afterBytes,
                verifyFlowPostDeleteAbsence: async () => ({
                    outcome:
                        FLOW_POST_DELETE_VERIFICATION_OUTCOME.STILL_PRESENT
                })
            });
            const result = await restore.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(
                result.code,
                ROLLBACK_CODE.POST_DELETE_VERIFICATION_FAILED
            );
        }
    );

    await runTest(
        'version-qualified Flow fails closed when Tooling post-delete verification is inconclusive',
        async () => {
            const { capture, sealed, afterBytes } =
                await sealFlowV4DeleteSnapshot();
            const restore = createFlowDeleteHarness({
                capture,
                retrieveBytes: afterBytes,
                verifyFlowPostDeleteAbsence: async () => ({
                    outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.FAIL_CLOSED,
                    detail: 'tooling unavailable'
                })
            });
            const result = await restore.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(
                result.code,
                ROLLBACK_CODE.POST_DELETE_VERIFICATION_FAILED
            );
            assert.match(result.message, /tooling unavailable/i);
        }
    );

    await runTest(
        'unversioned NEW Flow still uses definition-level inventory when post-delete EXISTS',
        async () => {
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const path = 'force-app/main/default/flows/My_Flow.flow-meta.xml';
            const afterBytes = packMemberFiles([
                {
                    relativePath: path,
                    bytes: Buffer.from('<Flow/>', 'utf8')
                }
            ]);
            const ready = await capture.captureSnapshot({
                deploymentContext: { destinationOrgId: '00D000000000001' },
                members: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'My_Flow',
                        filePath: path,
                        changeClass: CHANGE_CLASS.NEW,
                        expectedAfterHash: hashBytes(afterBytes)
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);
            const restore = createFlowDeleteHarness({
                capture,
                retrieveBytes: afterBytes,
                inventoryState: DESTINATION_STATE.EXISTS,
                verifyFlowPostDeleteAbsence: async () => ({
                    outcome:
                        FLOW_POST_DELETE_VERIFICATION_OUTCOME.USE_DEFINITION_INVENTORY
                })
            });
            const result = await restore.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(
                result.code,
                ROLLBACK_CODE.POST_DELETE_VERIFICATION_FAILED
            );
        }
    );

    await runTest(
        'unversioned NEW Flow succeeds when definition-level inventory is MISSING',
        async () => {
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const path = 'force-app/main/default/flows/My_Flow.flow-meta.xml';
            const afterBytes = packMemberFiles([
                {
                    relativePath: path,
                    bytes: Buffer.from('<Flow/>', 'utf8')
                }
            ]);
            const ready = await capture.captureSnapshot({
                deploymentContext: { destinationOrgId: '00D000000000001' },
                members: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'My_Flow',
                        filePath: path,
                        changeClass: CHANGE_CLASS.NEW,
                        expectedAfterHash: hashBytes(afterBytes)
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);
            const members = await capture.getMembers(sealed.snapshotId);

            assert.strictEqual(members[0].captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
            const restore = createFlowDeleteHarness({
                capture,
                retrieveBytes: afterBytes,
                inventoryState: DESTINATION_STATE.MISSING,
                verifyFlowPostDeleteAbsence: async () => ({
                    outcome:
                        FLOW_POST_DELETE_VERIFICATION_OUTCOME.USE_DEFINITION_INVENTORY
                })
            });
            const result = await restore.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.operationStatus, 'SUCCEEDED');
        }
    );

    await runTest(
        'restore integration: real verifier passes when v4 absent and v1 present despite definition inventory EXISTS',
        async () => {
            const { capture, sealed, afterBytes } =
                await sealFlowV4DeleteSnapshot();
            const { service } = buildFlowDeleteRestoreService({
                capture,
                retrieveBytes: afterBytes,
                inventoryState: DESTINATION_STATE.EXISTS,
                discoverFlowVersionsForPostDeleteVerification: async () =>
                    discoveryWithV1Only()
            });
            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.operationStatus, 'SUCCEEDED');
        }
    );

    await runTest(
        'restore integration: real verifier fails when target v4 still present on destination',
        async () => {
            const { capture, sealed, afterBytes } =
                await sealFlowV4DeleteSnapshot();
            const { service } = buildFlowDeleteRestoreService({
                capture,
                retrieveBytes: afterBytes,
                discoverFlowVersionsForPostDeleteVerification: async () =>
                    discoveryWithV4Present()
            });
            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(
                result.code,
                ROLLBACK_CODE.POST_DELETE_VERIFICATION_FAILED
            );
        }
    );

    await runTest(
        'restore integration: real verifier fails closed when Tooling discovery throws',
        async () => {
            const { capture, sealed, afterBytes } =
                await sealFlowV4DeleteSnapshot();
            const { service } = buildFlowDeleteRestoreService({
                capture,
                retrieveBytes: afterBytes,
                discoverFlowVersionsForPostDeleteVerification: async () => {
                    throw new Error('tooling unavailable');
                }
            });
            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(
                result.code,
                ROLLBACK_CODE.POST_DELETE_VERIFICATION_FAILED
            );
            assert.match(result.message, /tooling unavailable/i);
        }
    );

    await runTest(
        'restore integration: unversioned Flow still uses definition inventory when verifier defers',
        async () => {
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const path = 'force-app/main/default/flows/My_Flow.flow-meta.xml';
            const afterBytes = packMemberFiles([
                {
                    relativePath: path,
                    bytes: Buffer.from('<Flow/>', 'utf8')
                }
            ]);
            const ready = await capture.captureSnapshot({
                deploymentContext: { destinationOrgId: '00D000000000001' },
                members: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'My_Flow',
                        filePath: path,
                        changeClass: CHANGE_CLASS.NEW,
                        expectedAfterHash: hashBytes(afterBytes)
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);
            let toolingCalls = 0;
            const { service } = buildFlowDeleteRestoreService({
                capture,
                retrieveBytes: afterBytes,
                inventoryState: DESTINATION_STATE.MISSING,
                discoverFlowVersionsForPostDeleteVerification: async () => {
                    toolingCalls += 1;
                    throw new Error('Tooling must not run for unversioned Flow');
                }
            });
            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(toolingCalls, 0);
            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.operationStatus, 'SUCCEEDED');
        }
    );

    await runTest(
        'restore integration: non-Flow DELETE post-delete does not invoke Tooling discovery stub',
        async () => {
            const { capture, sealed, afterBytes } =
                await sealApexDeleteSnapshot();
            let toolingCalls = 0;
            const { service } = buildFlowDeleteRestoreService({
                capture,
                retrieveBytes: afterBytes,
                inventoryState: DESTINATION_STATE.MISSING,
                discoverFlowVersionsForPostDeleteVerification: async () => {
                    toolingCalls += 1;
                    throw new Error('Tooling must not run for ApexClass');
                }
            });
            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(toolingCalls, 0);
            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.operationStatus, 'SUCCEEDED');
        }
    );
})();
