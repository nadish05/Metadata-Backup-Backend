'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./snapshot.types');
const { hashBytes } = require('./snapshotIntegrity.service');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    ensureFlowDeleteRollbackActiveDeactivation,
    shouldConsiderFlowDeleteRollbackDeactivation,
    assertActiveVersionUnchanged
} = require('./flowDeleteRollbackActiveDeactivation.service');
const {
    buildFlowDefinitionDeactivationMetadataXml,
    validateFlowDefinitionDeactivationMetadataXml,
    buildFlowDefinitionDeactivationWorkspace
} = require('./flowDefinitionDeactivationMetadata.service');
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
const { ROLLBACK_MODE } = require('./snapshotRollbackEligibility.service');

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

function flowDeleteMember() {
    return {
        metadataType: 'Flow',
        metadataName: 'Check_Amount-4',
        changeClass: CHANGE_CLASS.NEW,
        captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
        existedBefore: false,
        expectedAfterHash: 'abc'
    };
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
            },
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: 1,
                sourceFlowVersionId: 'FLOW_V1_ID',
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

async function main() {
    await runTest('metadata — deactivation XML validates activeVersionNumber 0', () => {
        const xml = buildFlowDefinitionDeactivationMetadataXml();
        const validation = validateFlowDefinitionDeactivationMetadataXml(xml);
        assert.strictEqual(validation.ok, true);
        assert.strictEqual(validation.activeVersionNumber, 0);
    });

    await runTest('metadata — workspace contains FlowDefinition member only', async () => {
        const workspace = await buildFlowDefinitionDeactivationWorkspace({
            flowDefinitionDeveloperName: 'Check_Amount'
        });

        assert.ok(workspace.generatedDeploymentPackage.metadata.length === 1);
        assert.strictEqual(
            workspace.generatedDeploymentPackage.metadata[0].metadataType,
            'FlowDefinition'
        );
        assert.strictEqual(
            workspace.generatedDeploymentPackage.metadata[0].metadataName,
            'Check_Amount'
        );
        await workspace.cleanup();
    });

    await runTest('B — active Flow DELETE deactivates correct definition', async () => {
        let discoverCalls = 0;
        let checkOnlyCalls = 0;
        let executeCalls = 0;

        const discoverFlowVersionsFn = async () => {
            discoverCalls += 1;

            if (discoverCalls <= 2) {
                return discoveryActiveV4();
            }

            return discoveryDeactivatedV4();
        };

        const result = await ensureFlowDeleteRollbackActiveDeactivation({
            member: flowDeleteMember(),
            rollbackMode: ROLLBACK_MODE.DELETE,
            accessToken: 'token',
            instanceUrl: 'https://dest.example.com',
            refreshToken: 'refresh',
            discoverFlowVersionsFn,
            buildDeactivationWorkspaceFn: async (args) => {
                const workspace = await buildFlowDefinitionDeactivationWorkspace(args);
                const originalCleanup = workspace.cleanup;
                workspace.cleanup = async () => originalCleanup();
                return workspace;
            },
            checkOnlyFn: async () => {
                checkOnlyCalls += 1;
                return { success: true, status: 'Succeeded' };
            },
            executeFn: async () => {
                executeCalls += 1;
                return { success: true, status: 'Succeeded' };
            }
        });

        assert.strictEqual(result.deactivated, true);
        assert.strictEqual(result.flowDefinitionDeveloperName, 'Check_Amount');
        assert.strictEqual(result.priorActiveVersionId, 'FLOW_V4_ID');
        assert.strictEqual(checkOnlyCalls, 1);
        assert.strictEqual(executeCalls, 1);
        assert.ok(discoverCalls >= 3);
    });

    await runTest('A — inactive target skips deactivation deploy', async () => {
        let checkOnlyCalls = 0;

        const result = await ensureFlowDeleteRollbackActiveDeactivation({
            member: flowDeleteMember(),
            rollbackMode: ROLLBACK_MODE.DELETE,
            accessToken: 'token',
            instanceUrl: 'https://dest.example.com',
            discoverFlowVersionsFn: async () => discoveryInactiveV4(),
            checkOnlyFn: async () => {
                checkOnlyCalls += 1;
                return { success: true };
            },
            executeFn: async () => {
                throw new Error('execute should not run');
            }
        });

        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.reason, 'TARGET_NOT_ACTIVE');
        assert.strictEqual(checkOnlyCalls, 0);
    });

    await runTest('D — deactivation check-only failure blocks execution', async () => {
        let executeCalls = 0;

        try {
            await ensureFlowDeleteRollbackActiveDeactivation({
                member: flowDeleteMember(),
                rollbackMode: ROLLBACK_MODE.DELETE,
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com',
                discoverFlowVersionsFn: async () => discoveryActiveV4(),
                checkOnlyFn: async () => ({
                    success: false,
                    status: 'Failed',
                    message: 'check-only failed'
                }),
                executeFn: async () => {
                    executeCalls += 1;
                    return { success: true };
                }
            });
            assert.fail('expected throw');
        } catch (error) {
            assert.strictEqual(
                error.code,
                ROLLBACK_CODE.FLOW_DEACTIVATION_CHECK_ONLY_FAILED
            );
        }

        assert.strictEqual(executeCalls, 0);
    });

    await runTest('E — tooling failure prevents deactivation', async () => {
        try {
            await ensureFlowDeleteRollbackActiveDeactivation({
                member: flowDeleteMember(),
                rollbackMode: ROLLBACK_MODE.DELETE,
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com',
                discoverFlowVersionsFn: async () => {
                    throw new Error('tooling down');
                },
                checkOnlyFn: async () => ({ success: true }),
                executeFn: async () => ({ success: true })
            });
            assert.fail('expected throw');
        } catch (error) {
            assert.strictEqual(
                error.code,
                ROLLBACK_CODE.FLOW_DEACTIVATION_TOOLING_FAILED
            );
        }
    });

    await runTest('F — ambiguous version identity fails closed', async () => {
        try {
            await ensureFlowDeleteRollbackActiveDeactivation({
                member: flowDeleteMember(),
                rollbackMode: ROLLBACK_MODE.DELETE,
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com',
                discoverFlowVersionsFn: async () => ({
                    definitions: discoveryActiveV4().definitions,
                    versions: [
                        ...discoveryActiveV4().versions,
                        {
                            flowDefinitionDeveloperName: 'Check_Amount',
                            sourceFlowVersionNumber: 4,
                            sourceFlowVersionId: 'FLOW_V4_DUP',
                            flowIsActiveVersion: true,
                            flowVersionStatus: 'Active'
                        }
                    ]
                }),
                checkOnlyFn: async () => ({ success: true }),
                executeFn: async () => ({ success: true })
            });
            assert.fail('expected throw');
        } catch (error) {
            assert.strictEqual(
                error.code,
                ROLLBACK_CODE.FLOW_DEACTIVATION_IDENTITY_FAILED
            );
        }
    });

    await runTest('G — concurrent active-version change fails closed', async () => {
        let discoverCalls = 0;

        try {
            await ensureFlowDeleteRollbackActiveDeactivation({
                member: flowDeleteMember(),
                rollbackMode: ROLLBACK_MODE.DELETE,
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com',
                discoverFlowVersionsFn: async () => {
                    discoverCalls += 1;

                    if (discoverCalls === 1) {
                        return discoveryActiveV4();
                    }

                    return discoveryInactiveV4();
                },
                checkOnlyFn: async () => ({ success: true }),
                executeFn: async () => ({ success: true })
            });
            assert.fail('expected throw');
        } catch (error) {
            assert.strictEqual(
                error.code,
                ROLLBACK_CODE.FLOW_DEACTIVATION_ACTIVE_VERSION_CHANGED
            );
        }
    });

    await runTest('H — verification failure after deploy reports partial deactivation', async () => {
        let discoverCalls = 0;

        try {
            await ensureFlowDeleteRollbackActiveDeactivation({
                member: flowDeleteMember(),
                rollbackMode: ROLLBACK_MODE.DELETE,
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com',
                discoverFlowVersionsFn: async () => {
                    discoverCalls += 1;

                    if (discoverCalls <= 2) {
                        return discoveryActiveV4();
                    }

                    return discoveryActiveV4();
                },
                checkOnlyFn: async () => ({ success: true, status: 'Succeeded' }),
                executeFn: async () => ({
                    success: true,
                    status: 'Succeeded',
                    deploymentId: '0AfDEACT'
                })
            });
            assert.fail('expected throw');
        } catch (error) {
            assert.strictEqual(
                error.code,
                ROLLBACK_CODE.FLOW_DEACTIVATION_NOT_VERIFIED
            );
            assert.strictEqual(error.details.partialDeactivation, true);
            assert.strictEqual(error.details.priorActiveVersionId, 'FLOW_V4_ID');
        }
    });

    await runTest('L — non-Flow rollback does not invoke deactivation service', () => {
        const member = {
            metadataType: 'ApexClass',
            metadataName: 'MyClass',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            expectedAfterHash: 'abc'
        };

        assert.strictEqual(
            shouldConsiderFlowDeleteRollbackDeactivation(
                member,
                ROLLBACK_MODE.DELETE
            ),
            false
        );
    });

    await runTest('M — MODIFIED rollback member is not a deactivation candidate', () => {
        const member = {
            metadataType: 'Flow',
            metadataName: 'Check_Amount-4',
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'before',
            expectedAfterHash: 'after',
            artifactId: 'artifact-1'
        };

        assert.strictEqual(
            shouldConsiderFlowDeleteRollbackDeactivation(
                member,
                ROLLBACK_MODE.RESTORE
            ),
            false
        );
    });

    await runTest(
        'integration — inactive Flow DELETE path does not call deactivation deploy',
        async () => {
            const afterBytes = packMemberFiles([
                {
                    relativePath:
                        'force-app/main/default/flows/Check_Amount-4.flow-meta.xml',
                    bytes: Buffer.from('<Flow version="4"/>', 'utf8')
                }
            ]);
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const ready = await capture.captureSnapshot({
                deploymentContext: {
                    destinationOrgId: '00D000000000001',
                    sourceOrgId: '00D000000000002'
                },
                members: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Check_Amount-4',
                        changeClass: CHANGE_CLASS.NEW,
                        expectedAfterHash: hashBytes(afterBytes)
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);
            const operationStore = createMemoryRollbackOperationStore();
            let deactivationInvocations = 0;
            let destructiveCheckOnly = 0;

            const service = createDestinationSnapshotRestoreService({
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
                discoverFlowVersions: async () => discoveryInactiveV4(),
                ensureFlowDeleteRollbackActiveDeactivation: async () => {
                    deactivationInvocations += 1;
                    return { performed: false, skipped: true, reason: 'TARGET_NOT_ACTIVE' };
                },
                retrieveDestinationMember: async () => ({
                    artifactBytes: afterBytes,
                    flowExactVersionArtifactVerified: true
                }),
                runCheckOnlyDeployment: async () => {
                    destructiveCheckOnly += 1;
                    return { success: true, status: 'Succeeded' };
                },
                runDeploymentExecution: async () => ({
                    success: true,
                    status: 'Succeeded',
                    deploymentId: '0AfDELETE'
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
                    outcome: 'PASS'
                })
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(deactivationInvocations, 1);
            assert.strictEqual(destructiveCheckOnly, 1);
        }
    );

    await runTest(
        'integration — active Flow DELETE runs deactivation before destructive check-only',
        async () => {
            const afterBytes = packMemberFiles([
                {
                    relativePath:
                        'force-app/main/default/flows/Check_Amount-4.flow-meta.xml',
                    bytes: Buffer.from('<Flow version="4"/>', 'utf8')
                }
            ]);
            const capture = createSnapshotCaptureService({
                metadataStore: createMemorySnapshotMetadataStore(),
                blobStore: createMemorySnapshotBlobStore()
            });
            const ready = await capture.captureSnapshot({
                deploymentContext: {
                    destinationOrgId: '00D000000000001',
                    sourceOrgId: '00D000000000002'
                },
                members: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Check_Amount-4',
                        changeClass: CHANGE_CLASS.NEW,
                        expectedAfterHash: hashBytes(afterBytes)
                    }
                ]
            });
            const sealed = await capture.sealSnapshot(ready.snapshotId);
            const operationStore = createMemoryRollbackOperationStore();
            const checkOnlyStages = [];

            const service = createDestinationSnapshotRestoreService({
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
                ensureFlowDeleteRollbackActiveDeactivation: async () => ({
                    performed: true,
                    deactivated: true,
                    flowDefinitionDeveloperName: 'Check_Amount',
                    priorActiveVersionId: 'FLOW_V4_ID'
                }),
                retrieveDestinationMember: async () => ({
                    artifactBytes: afterBytes,
                    flowExactVersionArtifactVerified: true
                }),
                runCheckOnlyDeployment: async (args) => {
                    const types =
                        args.generatedWorkspace?.generatedDeploymentPackage?.metadata?.map(
                            (row) => row.metadataType
                        ) || [];
                    checkOnlyStages.push(types);
                    return { success: true, status: 'Succeeded' };
                },
                runDeploymentExecution: async () => ({
                    success: true,
                    status: 'Succeeded',
                    deploymentId: '0AfDELETE'
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
                    outcome: 'PASS'
                })
            });

            const result = await service.runRollback({
                snapshotId: sealed.snapshotId,
                refreshToken: 'refresh',
                instanceUrl: 'https://dest.example.com'
            });

            assert.strictEqual(result.success, true);
            assert.ok(
                checkOnlyStages.some((types) => types.includes('Flow')),
                'destructive check-only should still run'
            );
        }
    );

    await runTest('assertActiveVersionUnchanged detects identity mismatch', () => {
        const changed = assertActiveVersionUnchanged({
            discovery: discoveryInactiveV4(),
            definitionDeveloperName: 'Check_Amount',
            requestedVersion: 4,
            expectedActiveVersionId: 'FLOW_V4_ID'
        });

        assert.strictEqual(changed.ok, false);
        assert.strictEqual(changed.reason, 'ACTIVE_VERSION_CHANGED');
    });
}

main();
