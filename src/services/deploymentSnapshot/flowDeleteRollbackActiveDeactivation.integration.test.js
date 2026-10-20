'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    createDestinationSnapshotRestoreService
} = require('./destinationSnapshotRestore.service');
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
const { DESTINATION_STATE } = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    FLOW_POST_DELETE_VERIFICATION_OUTCOME
} = require('../retrieval/flowVersionDiscovery.service');

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

const FLOW_V4_PATH =
    'force-app/main/default/flows/Check_Amount-4.flow-meta.xml';

function flowV4Bytes(xml = '<Flow version="4"/>') {
    return packMemberFiles([
        {
            relativePath: FLOW_V4_PATH,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

async function sealFlowDeleteSnapshot(memberSpecs) {
    const capture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const afterBytes = flowV4Bytes();
    const members = memberSpecs.map((spec) => ({
        ...spec,
        expectedAfterHash: hashBytes(afterBytes)
    }));
    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: '00D000000000001',
            sourceOrgId: '00D000000000002'
        },
        members
    });
    const sealed = await capture.sealSnapshot(ready.snapshotId);

    return { capture, sealed, afterBytes };
}

function discoveryActiveV4() {
    return {
        definitions: [
            {
                developerName: 'Check_Amount',
                activeVersionId: 'FLOW_V4_ID',
                activeVersionNumber: 4,
                latestVersionId: 'FLOW_V4_ID',
                latestVersionNumber: 4
            }
        ],
        versions: [
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: 4,
                sourceFlowVersionId: 'FLOW_V4_ID',
                flowIsActiveVersion: true,
                flowVersionStatus: 'Active'
            }
        ]
    };
}

function discoveryDeactivatedV4() {
    return {
        definitions: [
            {
                developerName: 'Check_Amount',
                activeVersionId: null,
                activeVersionNumber: null,
                latestVersionId: 'FLOW_V4_ID',
                latestVersionNumber: 4
            }
        ],
        versions: [
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: 4,
                sourceFlowVersionId: 'FLOW_V4_ID',
                flowIsActiveVersion: false,
                flowVersionStatus: 'Obsolete'
            }
        ]
    };
}

function discoveryInactiveV4() {
    return {
        definitions: [
            {
                developerName: 'Check_Amount',
                activeVersionId: 'FLOW_V1_ID',
                activeVersionNumber: 1,
                latestVersionId: 'FLOW_V4_ID',
                latestVersionNumber: 4
            }
        ],
        versions: [
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: 4,
                sourceFlowVersionId: 'FLOW_V4_ID',
                flowIsActiveVersion: false,
                flowVersionStatus: 'Draft'
            }
        ]
    };
}

function buildRestoreHarness({
    capture,
    sealed,
    afterBytes,
    discoverFlowVersions,
    retrieveBytes = null,
    runCheckOnlyDeployment,
    runDeploymentExecution,
    ensureFlowDeleteRollbackActiveDeactivation
}) {
    const operationStore = createMemoryRollbackOperationStore();

    const options = {
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
            artifactBytes: retrieveBytes || afterBytes,
            flowExactVersionArtifactVerified: true
        }),
        refreshAccessToken: async () => ({
            accessToken: 'token',
            instanceUrl: 'https://dest.example.com'
        }),
        buildDestinationInventory: async ({ items }) => ({
            inventory: new Map(
                items.map((item) => [
                    `${item.metadataType}:${item.metadataName}`,
                    { state: DESTINATION_STATE.MISSING }
                ])
            )
        }),
        verifyVersionQualifiedFlowPostDeleteAbsence: async () => ({
            outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.PASS
        })
    };

    if (discoverFlowVersions) {
        options.discoverFlowVersions = discoverFlowVersions;
    }

    if (runCheckOnlyDeployment) {
        options.runCheckOnlyDeployment = runCheckOnlyDeployment;
    }

    if (runDeploymentExecution) {
        options.runDeploymentExecution = runDeploymentExecution;
    }

    if (ensureFlowDeleteRollbackActiveDeactivation) {
        options.ensureFlowDeleteRollbackActiveDeactivation =
            ensureFlowDeleteRollbackActiveDeactivation;
    }

    return {
        service: createDestinationSnapshotRestoreService(options),
        operationStore,
        sealed
    };
}

function workspaceMetadataTypes(workspace) {
    return (workspace?.generatedDeploymentPackage?.metadata || []).map(
        (row) => row.metadataType
    );
}

async function main() {
    await runTest(
        'integration 1 — active NEW Flow DELETE runs deactivation then destructive deploy',
        async () => {
            const { capture, sealed, afterBytes } = await sealFlowDeleteSnapshot([
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-4',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]);
            let discoverCalls = 0;
            let deactivationExecute = 0;
            let destructiveExecute = 0;

            const { service } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes,
                discoverFlowVersions: async () => {
                    discoverCalls += 1;

                    if (discoverCalls <= 2) {
                        return discoveryActiveV4();
                    }

                    return discoveryDeactivatedV4();
                },
                runCheckOnlyDeployment: async () => ({
                    success: true,
                    status: 'Succeeded'
                }),
                runDeploymentExecution: async (args) => {
                    const types = workspaceMetadataTypes(args.generatedWorkspace);

                    if (types.includes('FlowDefinition')) {
                        deactivationExecute += 1;
                    } else {
                        destructiveExecute += 1;
                    }

                    return {
                        success: true,
                        status: 'Succeeded',
                        deploymentId: `0Af_${types.join('_')}`
                    };
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(deactivationExecute, 1);
            assert.strictEqual(destructiveExecute, 1);
        }
    );

    await runTest(
        'integration 2 — deactivation verification failure blocks destructive deploy and persists partial state',
        async () => {
            const { capture, sealed, afterBytes } = await sealFlowDeleteSnapshot([
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-4',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]);
            let destructiveExecute = 0;
            let discoverCalls = 0;

            const { service, operationStore } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes,
                discoverFlowVersions: async () => {
                    discoverCalls += 1;

                    if (discoverCalls <= 2) {
                        return discoveryActiveV4();
                    }

                    return discoveryActiveV4();
                },
                runCheckOnlyDeployment: async () => ({
                    success: true,
                    status: 'Succeeded'
                }),
                runDeploymentExecution: async (args) => {
                    const types = workspaceMetadataTypes(args.generatedWorkspace);

                    if (!types.includes('FlowDefinition')) {
                        destructiveExecute += 1;
                    }

                    return {
                        success: true,
                        status: 'Succeeded',
                        deploymentId: '0Af_DEACT'
                    };
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, ROLLBACK_CODE.FLOW_DEACTIVATION_NOT_VERIFIED);
            assert.strictEqual(result.flowDeleteRollbackPartialDeactivation, true);
            assert.strictEqual(
                result.flowDeleteRollbackFailureStage,
                'DEACTIVATION_VERIFICATION'
            );
            assert.strictEqual(
                result.flowDeleteRollbackDeactivation[0].flowDefinitionDeveloperName,
                'Check_Amount'
            );
            assert.strictEqual(
                result.flowDeleteRollbackDeactivation[0].deactivationVerified,
                false
            );
            assert.strictEqual(destructiveExecute, 0);

            const operations = await operationStore.findByDestinationAndSnapshot(
                '00D000000000001',
                sealed.snapshotId
            );
            const terminal = operations.find((row) => row.status === 'FAILED');
            assert.ok(terminal);
            assert.strictEqual(
                terminal.flowDeleteRollbackPartialDeactivation,
                true
            );
            assert.strictEqual(
                terminal.flowDeleteRollbackFailureStage,
                'DEACTIVATION_VERIFICATION'
            );
        }
    );

    await runTest(
        'integration 3 — deactivation succeeds but drift fails without destructive deploy',
        async () => {
            const { capture, sealed, afterBytes } = await sealFlowDeleteSnapshot([
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-4',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]);
            let destructiveExecute = 0;
            const driftBytes = flowV4Bytes('<Flow version="4" drifted="yes"/>');

            const { service, operationStore } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes,
                discoverFlowVersions: async () => discoveryInactiveV4(),
                ensureFlowDeleteRollbackActiveDeactivation: async () => ({
                    performed: true,
                    deactivated: true,
                    deactivationVerified: true,
                    deactivationDeploySucceeded: true,
                    flowDefinitionDeveloperName: 'Check_Amount',
                    targetFlowVersionId: 'FLOW_V4_ID',
                    targetFlowVersionNumber: 4,
                    priorActiveVersionId: 'FLOW_V4_ID',
                    priorActiveVersionNumber: 4
                }),
                retrieveBytes: driftBytes,
                runDeploymentExecution: async (args) => {
                    if (
                        !workspaceMetadataTypes(args.generatedWorkspace).includes(
                            'FlowDefinition'
                        )
                    ) {
                        destructiveExecute += 1;
                    }

                    return { success: true, status: 'Succeeded' };
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, ROLLBACK_CODE.DRIFT_DETECTED);
            assert.strictEqual(result.flowDeleteRollbackPartialDeactivation, true);
            assert.strictEqual(result.flowDeleteRollbackFailureStage, 'DRIFT');
            assert.strictEqual(destructiveExecute, 0);

            const operations = await operationStore.findByDestinationAndSnapshot(
                '00D000000000001',
                sealed.snapshotId
            );
            const terminal = operations.find((row) => row.status === 'FAILED');
            assert.strictEqual(terminal.flowDeleteRollbackFailureStage, 'DRIFT');
        }
    );

    await runTest(
        'integration 4 — deactivation succeeds but destructive execution fails',
        async () => {
            const { capture, sealed, afterBytes } = await sealFlowDeleteSnapshot([
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-4',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]);

            const { service, operationStore } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes,
                discoverFlowVersions: async () => discoveryInactiveV4(),
                ensureFlowDeleteRollbackActiveDeactivation: async () => ({
                    performed: true,
                    deactivated: true,
                    deactivationVerified: true,
                    deactivationDeploySucceeded: true,
                    flowDefinitionDeveloperName: 'Check_Amount',
                    priorActiveVersionId: 'FLOW_V4_ID',
                    targetFlowVersionId: 'FLOW_V4_ID',
                    targetFlowVersionNumber: 4
                }),
                runCheckOnlyDeployment: async () => ({
                    success: true,
                    status: 'Succeeded'
                }),
                runDeploymentExecution: async (args) => {
                    if (
                        workspaceMetadataTypes(args.generatedWorkspace).includes(
                            'FlowDefinition'
                        )
                    ) {
                        return {
                            success: true,
                            status: 'Succeeded',
                            deploymentId: '0Af_DEACT'
                        };
                    }

                    return {
                        success: false,
                        status: 'Failed',
                        message: 'destructive failed'
                    };
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.flowDeleteRollbackPartialDeactivation, true);
            assert.strictEqual(result.flowDeleteRollbackFailureStage, 'EXECUTION');

            const operations = await operationStore.findByDestinationAndSnapshot(
                '00D000000000001',
                sealed.snapshotId
            );
            const terminal = operations.find((row) => row.status === 'FAILED');
            assert.notStrictEqual(terminal.success, true);
            assert.strictEqual(
                terminal.flowDeleteRollbackPartialDeactivation,
                true
            );
        }
    );

    await runTest(
        'integration 4b — deactivation succeeds but destructive execute throws',
        async () => {
            const { capture, sealed, afterBytes } = await sealFlowDeleteSnapshot([
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-4',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]);

            const { service, operationStore } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes,
                discoverFlowVersions: async () => discoveryInactiveV4(),
                ensureFlowDeleteRollbackActiveDeactivation: async () => ({
                    performed: true,
                    deactivated: true,
                    deactivationVerified: true,
                    deactivationDeploySucceeded: true,
                    flowDefinitionDeveloperName: 'Check_Amount',
                    priorActiveVersionId: 'FLOW_V4_ID',
                    targetFlowVersionId: 'FLOW_V4_ID',
                    targetFlowVersionNumber: 4
                }),
                runCheckOnlyDeployment: async () => ({
                    success: true,
                    status: 'Succeeded'
                }),
                runDeploymentExecution: async (args) => {
                    if (
                        workspaceMetadataTypes(args.generatedWorkspace).includes(
                            'FlowDefinition'
                        )
                    ) {
                        return {
                            success: true,
                            status: 'Succeeded',
                            deploymentId: '0Af_DEACT'
                        };
                    }

                    throw new Error('destructive execute threw');
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.flowDeleteRollbackPartialDeactivation, true);
            assert.strictEqual(result.flowDeleteRollbackFailureStage, 'EXECUTION');

            const operations = await operationStore.findByDestinationAndSnapshot(
                '00D000000000001',
                sealed.snapshotId
            );
            const terminal = operations.find((row) => row.status === 'FAILED');
            assert.ok(terminal);
            assert.notStrictEqual(terminal.success, true);
            assert.strictEqual(
                terminal.flowDeleteRollbackPartialDeactivation,
                true
            );
            assert.strictEqual(terminal.flowDeleteRollbackFailureStage, 'EXECUTION');
            assert.ok(Array.isArray(terminal.flowDeleteRollbackDeactivation));
            assert.strictEqual(
                terminal.flowDeleteRollbackDeactivation[0].flowDefinitionDeveloperName,
                'Check_Amount'
            );
        }
    );

    await runTest(
        'integration 5 — inactive NEW Flow DELETE skips deactivation deploy',
        async () => {
            const { capture, sealed, afterBytes } = await sealFlowDeleteSnapshot([
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-4',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]);
            let deactivationExecute = 0;

            const { service } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes,
                discoverFlowVersions: async () => discoveryInactiveV4(),
                runCheckOnlyDeployment: async () => ({
                    success: true,
                    status: 'Succeeded'
                }),
                runDeploymentExecution: async (args) => {
                    if (
                        workspaceMetadataTypes(args.generatedWorkspace).includes(
                            'FlowDefinition'
                        )
                    ) {
                        deactivationExecute += 1;
                    }

                    return {
                        success: true,
                        status: 'Succeeded',
                        deploymentId: '0Af_DELETE'
                    };
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(deactivationExecute, 0);
        }
    );

    await runTest(
        'integration 6 — ApexClass DELETE does not run Flow deactivation deploy',
        async () => {
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const clsBytes = packMemberFiles([
                {
                    relativePath:
                        'force-app/main/default/classes/Demo.cls',
                    bytes: Buffer.from('public class Demo {}', 'utf8')
                }
            ]);
            const ready = await capture.captureSnapshot({
                deploymentContext: {
                    destinationOrgId: '00D000000000001',
                    sourceOrgId: '00D000000000002'
                },
                members: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Demo',
                        changeClass: CHANGE_CLASS.NEW,
                        expectedAfterHash: hashBytes(clsBytes)
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);
            let deactivationExecute = 0;

            const { service } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes: clsBytes,
                retrieveBytes: clsBytes,
                runCheckOnlyDeployment: async () => ({
                    success: true,
                    status: 'Succeeded'
                }),
                runDeploymentExecution: async (args) => {
                    if (
                        workspaceMetadataTypes(args.generatedWorkspace).includes(
                            'FlowDefinition'
                        )
                    ) {
                        deactivationExecute += 1;
                    }

                    return {
                        success: true,
                        status: 'Succeeded',
                        deploymentId: '0Af_APEX'
                    };
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(deactivationExecute, 0);
        }
    );

    await runTest(
        'integration 7 — two DELETE versions: single deactivation when first target is active',
        async () => {
            const { capture, sealed, afterBytes } = await sealFlowDeleteSnapshot([
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-4',
                    changeClass: CHANGE_CLASS.NEW
                },
                {
                    metadataType: 'Flow',
                    metadataName: 'Check_Amount-5',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]);
            let flowDefinitionDeactivated = false;
            let deactivationExecute = 0;

            const activeBothVersions = () => ({
                definitions: [
                    {
                        developerName: 'Check_Amount',
                        activeVersionId: 'FLOW_V5_ID',
                        activeVersionNumber: 5,
                        latestVersionId: 'FLOW_V5_ID',
                        latestVersionNumber: 5
                    }
                ],
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 4,
                        sourceFlowVersionId: 'FLOW_V4_ID',
                        flowIsActiveVersion: false,
                        flowVersionStatus: 'Obsolete'
                    },
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 5,
                        sourceFlowVersionId: 'FLOW_V5_ID',
                        flowIsActiveVersion: true,
                        flowVersionStatus: 'Active'
                    }
                ]
            });

            const deactivatedBothVersions = () => ({
                definitions: [
                    {
                        developerName: 'Check_Amount',
                        activeVersionId: null,
                        activeVersionNumber: null,
                        latestVersionId: 'FLOW_V5_ID',
                        latestVersionNumber: 5
                    }
                ],
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 4,
                        sourceFlowVersionId: 'FLOW_V4_ID',
                        flowIsActiveVersion: false,
                        flowVersionStatus: 'Obsolete'
                    },
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 5,
                        sourceFlowVersionId: 'FLOW_V5_ID',
                        flowIsActiveVersion: false,
                        flowVersionStatus: 'Obsolete'
                    }
                ]
            });

            const { service } = buildRestoreHarness({
                capture,
                sealed,
                afterBytes,
                discoverFlowVersions: async () =>
                    flowDefinitionDeactivated
                        ? deactivatedBothVersions()
                        : activeBothVersions(),
                runCheckOnlyDeployment: async () => ({
                    success: true,
                    status: 'Succeeded'
                }),
                runDeploymentExecution: async (args) => {
                    if (
                        workspaceMetadataTypes(args.generatedWorkspace).includes(
                            'FlowDefinition'
                        )
                    ) {
                        deactivationExecute += 1;
                        flowDefinitionDeactivated = true;
                    }

                    return {
                        success: true,
                        status: 'Succeeded',
                        deploymentId: '0Af_DEACT'
                    };
                }
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com',
                accessToken: 'token'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(deactivationExecute, 1);
        }
    );
}

main();
