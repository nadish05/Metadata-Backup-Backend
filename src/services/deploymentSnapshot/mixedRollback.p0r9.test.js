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
    isDeleteRollbackEligibleMember,
    isModifiedRollbackEligibleMember,
    resolveRollbackMode,
    ROLLBACK_MODE
} = require('./snapshotRollbackEligibility.service');
const { partitionMixedRollbackMembers } = require('./mixedRollbackWorkspace.service');
const { buildProjectDeployCommand } = require('../checkOnlyDeployment.service');
const {
    createDestinationSnapshotRestoreService
} = require('./destinationSnapshotRestore.service');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    createRollbackOperationService
} = require('./rollbackOperation.service');
const { ROLLBACK_OPERATION_STATUS } = require('./rollbackOperation.types');
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
const { DRIFT_CLASSIFICATION } = require('./snapshotDriftComparison.service');

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

function modifiedClassBeforeBytes() {
    return packMemberFiles([
        {
            relativePath:
                'force-app/main/default/classes/DemoModifiedClass.cls',
            bytes: Buffer.from(
                'public class DemoModifiedClass {\n    // before\n}\n',
                'utf8'
            )
        }
    ]);
}

function modifiedClassAfterBytes() {
    return packMemberFiles([
        {
            relativePath:
                'force-app/main/default/classes/DemoModifiedClass.cls',
            bytes: Buffer.from(
                'public class DemoModifiedClass {\n    // after\n}\n',
                'utf8'
            )
        }
    ]);
}

function deletedClassAfterBytes() {
    return packMemberFiles([
        {
            relativePath:
                'force-app/main/default/classes/DemoDeletedClass.cls',
            bytes: Buffer.from(
                'public class DemoDeletedClass {\n    // deployed\n}\n',
                'utf8'
            )
        }
    ]);
}

async function sealMixedSnapshot() {
    const capture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const beforeBytes = modifiedClassBeforeBytes();
    const modifiedAfterBytes = modifiedClassAfterBytes();
    const deletedAfterBytes = deletedClassAfterBytes();

    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: '00D000000000001',
            sourceOrgId: '00D000000000002'
        },
        members: [
            {
                metadataType: 'ApexClass',
                metadataName: 'DemoModifiedClass',
                filePath:
                    'force-app/main/default/classes/DemoModifiedClass.cls',
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: beforeBytes,
                expectedAfterHash: hashBytes(modifiedAfterBytes)
            },
            {
                metadataType: 'ApexClass',
                metadataName: 'DemoDeletedClass',
                filePath:
                    'force-app/main/default/classes/DemoDeletedClass.cls',
                changeClass: CHANGE_CLASS.NEW,
                expectedAfterHash: hashBytes(deletedAfterBytes)
            }
        ]
    });
    const sealed = await capture.sealSnapshot(ready.snapshotId);
    const members = await capture.getMembers(sealed.snapshotId);

    return {
        capture,
        sealed,
        members,
        beforeBytes,
        modifiedAfterBytes,
        deletedAfterBytes
    };
}

function createMixedRestoreHarness({
    capture,
    retrieveResponses = {},
    checkOnlySuccess = true,
    executeSuccess = true,
    inventoryState = DESTINATION_STATE.MISSING,
    postRestoreBytes = null,
    onMixedWorkspaceBuild = null
} = {}) {
    let mixedWorkspaceBuildCount = 0;
    let restoreWorkspaceBuildCount = 0;
    let deleteWorkspaceBuildCount = 0;
    let checkOnlyCalls = 0;
    let executeCalls = 0;
    let lastCheckOnlyWorkspace = null;
    let lastExecuteWorkspace = null;
    const terminalTransitions = [];
    const operationStore = createMemoryRollbackOperationStore();
    const baseOperationService = createRollbackOperationService({
        getStore: () => operationStore
    });
    const operationService = {
        ...baseOperationService,
        async markTerminal(operationId, outcome) {
            terminalTransitions.push(outcome.status);
            return baseOperationService.markTerminal(operationId, outcome);
        }
    };

    const service = createDestinationSnapshotRestoreService({
        getRollbackOperationStore: () => operationStore,
        rollbackOperationService: operationService,
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
        retrieveDestinationMember: async ({ metadataName }) => {
            const response = retrieveResponses[metadataName];

            if (typeof response === 'function') {
                return response();
            }

            return response || { artifactBytes: null, files: [] };
        },
        buildMixedRollbackWorkspace: async (args) => {
            mixedWorkspaceBuildCount += 1;
            if (typeof onMixedWorkspaceBuild === 'function') {
                await onMixedWorkspaceBuild(args);
            }

            const { buildMixedRollbackWorkspace } = require('./mixedRollbackWorkspace.service');

            return buildMixedRollbackWorkspace(args);
        },
        buildRestoreWorkspace: async () => {
            restoreWorkspaceBuildCount += 1;
            throw new Error('RESTORE workspace should not be used for MIXED rollback');
        },
        buildDeleteRollbackWorkspace: async () => {
            deleteWorkspaceBuildCount += 1;
            throw new Error('DELETE workspace should not be used for MIXED rollback');
        },
        runCheckOnlyDeployment: async ({ generatedWorkspace }) => {
            checkOnlyCalls += 1;
            lastCheckOnlyWorkspace = generatedWorkspace;
            return {
                executed: true,
                success: checkOnlySuccess,
                status: checkOnlySuccess ? 'Succeeded' : 'Failed',
                message: checkOnlySuccess ? 'ok' : 'check-only failed'
            };
        },
        runDeploymentExecution: async ({ generatedWorkspace }) => {
            executeCalls += 1;
            lastExecuteWorkspace = generatedWorkspace;
            return {
                success: executeSuccess,
                status: executeSuccess ? 'Succeeded' : 'Failed',
                deploymentId: '0AfMIXED000001',
                message: executeSuccess ? 'deployed' : 'deploy failed'
            };
        },
        refreshAccessToken: async () => ({
            accessToken: 'refreshed-access-token',
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
    });

    return {
        service,
        operationStore,
        terminalTransitions,
        getCounts: () => ({
            mixedWorkspaceBuildCount,
            restoreWorkspaceBuildCount,
            deleteWorkspaceBuildCount,
            checkOnlyCalls,
            executeCalls
        }),
        getLastWorkspaces: () => ({
            checkOnlyWorkspace: lastCheckOnlyWorkspace,
            executeWorkspace: lastExecuteWorkspace
        }),
        getPostRestoreRetrieve: () => postRestoreBytes
    };
}

(async () => {
    await runTest('M1. MODIFIED + DELETE members partition correctly', async () => {
        const { members } = await sealMixedSnapshot();
        const partitioned = partitionMixedRollbackMembers(members);

        assert.strictEqual(resolveRollbackMode(members), ROLLBACK_MODE.MIXED);
        assert.strictEqual(partitioned.restoreMembers.length, 1);
        assert.strictEqual(partitioned.deleteMembers.length, 1);
        assert.strictEqual(
            partitioned.restoreMembers[0].metadataName,
            'DemoModifiedClass'
        );
        assert.strictEqual(
            partitioned.deleteMembers[0].metadataName,
            'DemoDeletedClass'
        );
    });

    await runTest('M2-M6. mixed preflight validates all members', async () => {
        const {
            capture,
            sealed,
            modifiedAfterBytes,
            deletedAfterBytes,
            beforeBytes
        } = await sealMixedSnapshot();
        let modifiedRetrieveCount = 0;
        const harness = createMixedRestoreHarness({
            capture,
            retrieveResponses: {
                DemoModifiedClass: () => {
                    modifiedRetrieveCount += 1;
                    return {
                        artifactBytes:
                            modifiedRetrieveCount > 1
                                ? beforeBytes
                                : modifiedAfterBytes,
                        files: []
                    };
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.blocked, false);
        assert.strictEqual(harness.getCounts().checkOnlyCalls, 1);
        assert.ok(result.drift.length === 2);
        assert.strictEqual(
            result.drift.every(
                (entry) =>
                    entry.classification ===
                    DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            ),
            true
        );
    });

    await runTest('M3. MODIFIED preflight failure prevents execution', async () => {
        const { capture, sealed, deletedAfterBytes } = await sealMixedSnapshot();
        const harness = createMixedRestoreHarness({
            capture,
            retrieveResponses: {
                DemoModifiedClass: {
                    artifactBytes: Buffer.from('drifted-modified\n'),
                    files: []
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.strictEqual(harness.getCounts().executeCalls, 0);
        assert.deepStrictEqual(harness.terminalTransitions, [
            ROLLBACK_OPERATION_STATUS.FAILED
        ]);
    });

    await runTest('M4-M5. DELETE preflight failure prevents execution', async () => {
        const { capture, sealed, modifiedAfterBytes } = await sealMixedSnapshot();
        const harness = createMixedRestoreHarness({
            capture,
            retrieveResponses: {
                DemoModifiedClass: {
                    artifactBytes: modifiedAfterBytes,
                    files: []
                },
                DemoDeletedClass: {
                    artifactBytes: Buffer.from('drifted-delete\n'),
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.strictEqual(harness.getCounts().executeCalls, 0);
    });

    await runTest('M7. mixed workspace builder called exactly once', async () => {
        const {
            capture,
            sealed,
            modifiedAfterBytes,
            deletedAfterBytes
        } = await sealMixedSnapshot();
        const harness = createMixedRestoreHarness({
            capture,
            retrieveResponses: {
                DemoModifiedClass: {
                    artifactBytes: modifiedAfterBytes,
                    files: []
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });

        await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(harness.getCounts().mixedWorkspaceBuildCount, 1);
        assert.strictEqual(harness.getCounts().restoreWorkspaceBuildCount, 0);
        assert.strictEqual(harness.getCounts().deleteWorkspaceBuildCount, 0);
    });

    await runTest('M8-M11. one mixed check-only and one mixed deployment only', async () => {
        const {
            capture,
            sealed,
            modifiedAfterBytes,
            deletedAfterBytes,
            beforeBytes
        } = await sealMixedSnapshot();
        let modifiedRetrieveCount = 0;
        const harness = createMixedRestoreHarness({
            capture,
            retrieveResponses: {
                DemoModifiedClass: () => {
                    modifiedRetrieveCount += 1;
                    return {
                        artifactBytes:
                            modifiedRetrieveCount > 1
                                ? beforeBytes
                                : modifiedAfterBytes,
                        files: []
                    };
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        const workspaces = harness.getLastWorkspaces();
        const command = buildProjectDeployCommand({
            workspacePath: workspaces.checkOnlyWorkspace.workspacePath,
            alias: 'dest',
            deploymentValidationFlag: '--dry-run',
            preDestructiveChangesPath:
                workspaces.checkOnlyWorkspace.preDestructiveChangesPath
        });

        assert.strictEqual(harness.getCounts().checkOnlyCalls, 1);
        assert.strictEqual(harness.getCounts().executeCalls, 1);
        assert.strictEqual(harness.getCounts().restoreWorkspaceBuildCount, 0);
        assert.strictEqual(harness.getCounts().deleteWorkspaceBuildCount, 0);
        assert.match(command, /--manifest package\.xml/);
        assert.match(
            command,
            /--pre-destructive-changes "destructiveChanges\.xml"/
        );
        assert.strictEqual(result.blocked, false);
    });

    await runTest('M12. check-only failure prevents actual deployment', async () => {
        const {
            capture,
            sealed,
            modifiedAfterBytes,
            deletedAfterBytes
        } = await sealMixedSnapshot();
        const harness = createMixedRestoreHarness({
            capture,
            checkOnlySuccess: false,
            retrieveResponses: {
                DemoModifiedClass: {
                    artifactBytes: modifiedAfterBytes,
                    files: []
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.CHECK_ONLY_FAILED);
        assert.strictEqual(harness.getCounts().executeCalls, 0);
    });

    await runTest('M13-M20. successful mixed rollback succeeds with one deployment ID', async () => {
        const {
            capture,
            sealed,
            modifiedAfterBytes,
            deletedAfterBytes,
            beforeBytes
        } = await sealMixedSnapshot();
        let modifiedRetrieveCount = 0;
        const harness = createMixedRestoreHarness({
            capture,
            retrieveResponses: {
                DemoModifiedClass: () => {
                    modifiedRetrieveCount += 1;
                    return {
                        artifactBytes:
                            modifiedRetrieveCount > 1
                                ? beforeBytes
                                : modifiedAfterBytes,
                        files: []
                    };
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });
        const operations = await harness.operationStore.findBySnapshotId(
            sealed.snapshotId
        );

        assert.strictEqual(result.blocked, false);
        assert.strictEqual(result.operationStatus, 'SUCCEEDED');
        assert.strictEqual(harness.getCounts().executeCalls, 1);
        assert.deepStrictEqual(harness.terminalTransitions, [
            ROLLBACK_OPERATION_STATUS.SUCCEEDED
        ]);
        assert.strictEqual(
            harness.terminalTransitions.includes(
                ROLLBACK_OPERATION_STATUS.FAILED
            ),
            false
        );
        assert.strictEqual(operations[0]?.salesforceDeploymentId, '0AfMIXED000001');
    });

    await runTest('M15-M18. DELETE verification failure transitions IN_PROGRESS to FAILED', async () => {
        const {
            capture,
            sealed,
            modifiedAfterBytes,
            deletedAfterBytes,
            beforeBytes
        } = await sealMixedSnapshot();
        let modifiedRetrieveCount = 0;
        const harness = createMixedRestoreHarness({
            capture,
            inventoryState: DESTINATION_STATE.EXISTS,
            retrieveResponses: {
                DemoModifiedClass: () => {
                    modifiedRetrieveCount += 1;
                    return {
                        artifactBytes:
                            modifiedRetrieveCount > 1
                                ? beforeBytes
                                : modifiedAfterBytes,
                        files: []
                    };
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(
            result.code,
            ROLLBACK_CODE.POST_DELETE_VERIFICATION_FAILED
        );
        assert.deepStrictEqual(harness.terminalTransitions, [
            ROLLBACK_OPERATION_STATUS.FAILED
        ]);
        assert.strictEqual(
            harness.terminalTransitions.includes(
                ROLLBACK_OPERATION_STATUS.SUCCEEDED
            ),
            false
        );
    });

    await runTest('M16-M17. MODIFIED post-verification failure transitions to FAILED', async () => {
        const {
            capture,
            sealed,
            modifiedAfterBytes,
            deletedAfterBytes
        } = await sealMixedSnapshot();
        let modifiedRetrieveCount = 0;
        const harness = createMixedRestoreHarness({
            capture,
            retrieveResponses: {
                DemoModifiedClass: () => {
                    modifiedRetrieveCount += 1;
                    return {
                        artifactBytes:
                            modifiedRetrieveCount > 1
                                ? modifiedAfterBytes
                                : modifiedAfterBytes,
                        files: []
                    };
                },
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.deepStrictEqual(harness.terminalTransitions, [
            ROLLBACK_OPERATION_STATUS.FAILED
        ]);
    });

    await runTest('M23. MIXED with unsupported member remains blocked', async () => {
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const ready = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: '00D000000000001' },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'DemoModifiedClass',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: modifiedClassBeforeBytes(),
                    expectedAfterHash: hashBytes(modifiedClassAfterBytes())
                },
                {
                    metadataType: 'ApexClass',
                    metadataName: 'UnsupportedClass',
                    changeClass: CHANGE_CLASS.UNKNOWN
                }
            ]
        });
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        const harness = createMixedRestoreHarness({ capture });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE);
    });

    await runTest('M24. MIXED with DELETE member missing expectedAfterHash remains blocked', async () => {
        const { capture, sealed } = await sealMixedSnapshot();
        const invalidCapture = {
            getSnapshot: (...args) => capture.getSnapshot(...args),
            getArtifact: (...args) => capture.getArtifact(...args),
            verifySnapshotIntegrity: (...args) =>
                capture.verifySnapshotIntegrity(...args),
            getMembers: async (snapshotId) => {
                const stored = await capture.getMembers(snapshotId);

                return stored.map((member) =>
                    member.metadataName === 'DemoDeletedClass'
                        ? { ...member, expectedAfterHash: null }
                        : member
                );
            }
        };
        const harness = createMixedRestoreHarness({ capture: invalidCapture });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE);
    });

    await runTest('M25. MIXED with MODIFIED member missing artifact remains blocked', async () => {
        const { capture, sealed, deletedAfterBytes } = await sealMixedSnapshot();
        const invalidCapture = {
            getSnapshot: (...args) => capture.getSnapshot(...args),
            verifySnapshotIntegrity: (...args) =>
                capture.verifySnapshotIntegrity(...args),
            getMembers: async (snapshotId) => {
                const stored = await capture.getMembers(snapshotId);

                return stored.map((member) =>
                    member.metadataName === 'DemoModifiedClass'
                        ? { ...member, artifactId: null }
                        : member
                );
            },
            getArtifact: (...args) => capture.getArtifact(...args)
        };
        const harness = createMixedRestoreHarness({
            capture: invalidCapture,
            retrieveResponses: {
                DemoDeletedClass: {
                    artifactBytes: deletedAfterBytes,
                    files: []
                }
            }
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE);
    });
})();
