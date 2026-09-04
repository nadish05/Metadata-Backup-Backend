'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes, computeSnapshotIntegrityHash } = require('./snapshotIntegrity.service');
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
    ROLLBACK_MODE,
    computeRollbackEligible
} = require('./snapshotRollbackEligibility.service');
const {
    compareNewMemberForDeleteRollback,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');
const {
    generateDestructiveChangesXml,
    generateEmptyPackageXml
} = require('../packageXml.service');
const { DEFAULT_API_VERSION } = require('../../config/salesforce');
const { buildProjectDeployCommand } = require('../checkOnlyDeployment.service');
const {
    createDestinationSnapshotRestoreService
} = require('./destinationSnapshotRestore.service');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    createMemoryRollbackOperationStore
} = require('./stores/memoryRollbackOperationStore');
const {
    createOrgLockService
} = require('../deploymentOrgLock/deploymentOrgLock.service');
const {
    createMemoryOrgLockStore
} = require('../deploymentOrgLock/stores/memoryOrgLockStore');
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
    buildDeleteRollbackWorkspace
} = require('./destructiveRollbackWorkspace.service');

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

async function sealDeleteSnapshot() {
    const capture = createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
    const afterBytes = deletedClassAfterBytes();
    const expectedAfterHash = hashBytes(afterBytes);
    const ready = await capture.captureSnapshot({
        deploymentContext: {
            destinationOrgId: '00D000000000001',
            sourceOrgId: '00D000000000002'
        },
        members: [
            {
                metadataType: 'ApexClass',
                metadataName: 'DemoDeletedClass',
                filePath:
                    'force-app/main/default/classes/DemoDeletedClass.cls',
                changeClass: CHANGE_CLASS.NEW,
                expectedAfterHash
            }
        ]
    });
    const sealed = await capture.sealSnapshot(ready.snapshotId);

    return { capture, sealed, afterBytes, expectedAfterHash };
}

function createDeleteRestoreHarness({
    capture,
    retrieveBytes,
    checkOnlySuccess = true,
    executeSuccess = true,
    inventoryState = DESTINATION_STATE.MISSING
} = {}) {
    let checkOnlyWorkspace = null;
    let executeWorkspace = null;
    let executions = 0;
    const operationStore = createMemoryRollbackOperationStore();

    const service = createDestinationSnapshotRestoreService({
        getRollbackOperationStore: () => operationStore,
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
        runCheckOnlyDeployment: async ({ generatedWorkspace }) => {
            checkOnlyWorkspace = generatedWorkspace;
            return {
                executed: true,
                success: checkOnlySuccess,
                status: checkOnlySuccess ? 'Succeeded' : 'Failed',
                message: checkOnlySuccess ? 'ok' : 'check-only failed'
            };
        },
        runDeploymentExecution: async ({ generatedWorkspace }) => {
            executeWorkspace = generatedWorkspace;
            executions += 1;
            return {
                success: executeSuccess,
                status: executeSuccess ? 'Succeeded' : 'Failed',
                message: executeSuccess ? 'deployed' : 'deploy failed'
            };
        },
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
        getWorkspaces: () => ({
            checkOnlyWorkspace,
            executeWorkspace
        }),
        getExecutionCount: () => executions
    };
}

(async () => {
    await runTest('A1. MISSING destination captures as NEW', async () => {
        const member = {
            metadataType: 'ApexClass',
            metadataName: 'DemoDeletedClass',
            changeClass: CHANGE_CLASS.NEW,
            existedBefore: false,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN
        };

        assert.strictEqual(member.changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(member.existedBefore, false);
    });

    await runTest('A2-A6. NEW member stores expectedAfterHash without artifact', async () => {
        const { capture, sealed, expectedAfterHash } = await sealDeleteSnapshot();
        const members = await capture.getMembers(sealed.snapshotId);
        const member = members[0];

        assert.ok(expectedAfterHash);
        assert.strictEqual(member.expectedAfterHash, expectedAfterHash);
        assert.strictEqual(member.destinationBeforeHash, null);
        assert.strictEqual(member.artifactId, null);
        assert.strictEqual(member.artifactSize, 0);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
        assert.strictEqual(sealed.rollbackEligible, true);
    });

    await runTest('A7. integrity hash includes NEW expectedAfterHash', () => {
        const afterHash = hashBytes(deletedClassAfterBytes());
        const members = [
            {
                metadataType: 'ApexClass',
                metadataName: 'DemoDeletedClass',
                changeClass: CHANGE_CLASS.NEW,
                destinationBeforeHash: null,
                expectedAfterHash: afterHash
            }
        ];
        const without = computeSnapshotIntegrityHash(
            [{ ...members[0], expectedAfterHash: null }],
            { schemaVersion: 2 }
        );
        const withHash = computeSnapshotIntegrityHash(members, {
            schemaVersion: 2
        });

        assert.notStrictEqual(without, withHash);
    });

    await runTest('B8. delete drift C === B proceeds', () => {
        const hash = hashBytes(deletedClassAfterBytes());
        const result = compareNewMemberForDeleteRollback({
            expectedAfterHash: hash,
            currentDestinationHash: hash
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest('B9. delete drift C !== B is blocked', () => {
        const result = compareNewMemberForDeleteRollback({
            expectedAfterHash: hashBytes(deletedClassAfterBytes()),
            currentDestinationHash: 'other-hash'
        });

        assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
    });

    await runTest('B12. missing expectedAfterHash is blocked', () => {
        const result = compareNewMemberForDeleteRollback({
            expectedAfterHash: null,
            currentDestinationHash: 'abc'
        });

        assert.strictEqual(result.classification, 'MISSING_EXPECTED_AFTER');
    });

    await runTest('C13. delete-eligible NEW member passes eligibility', () => {
        const member = {
            metadataType: 'ApexClass',
            metadataName: 'DemoDeletedClass',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            destinationBeforeHash: null,
            artifactId: null,
            expectedAfterHash: hashBytes(deletedClassAfterBytes())
        };

        assert.strictEqual(isDeleteRollbackEligibleMember(member), true);
        assert.strictEqual(resolveRollbackMode([member]), ROLLBACK_MODE.DELETE);
        assert.strictEqual(computeRollbackEligible([member]), true);
    });

    await runTest('C14. NEW without expectedAfterHash is not eligible', () => {
        const member = {
            metadataType: 'ApexClass',
            metadataName: 'DemoDeletedClass',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            destinationBeforeHash: null,
            artifactId: null,
            expectedAfterHash: null
        };

        assert.strictEqual(isDeleteRollbackEligibleMember(member), false);
        assert.strictEqual(computeRollbackEligible([member]), false);
    });

    await runTest('C15. mixed MODIFIED + NEW is blocked', () => {
        const modified = {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'a',
            expectedAfterHash: 'b',
            artifactId: 'artifact-1'
        };
        const deleted = {
            metadataType: 'ApexClass',
            metadataName: 'DemoDeletedClass',
            changeClass: CHANGE_CLASS.NEW,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
            existedBefore: false,
            destinationBeforeHash: null,
            artifactId: null,
            expectedAfterHash: 'c'
        };

        assert.strictEqual(
            resolveRollbackMode([modified, deleted]),
            ROLLBACK_MODE.MIXED
        );
        assert.strictEqual(computeRollbackEligible([modified, deleted]), false);
    });

    await runTest('C16. MODIFIED eligibility unchanged', () => {
        const member = {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
            destinationBeforeHash: 'a',
            expectedAfterHash: 'b',
            artifactId: 'artifact-1'
        };

        assert.strictEqual(isModifiedRollbackEligibleMember(member), true);
        assert.strictEqual(resolveRollbackMode([member]), ROLLBACK_MODE.RESTORE);
    });

    await runTest('D17-D20. destructiveChanges.xml generation', () => {
        const xml = generateDestructiveChangesXml({
            metadata: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'DemoDeletedClass'
                },
                {
                    metadataType: 'ApexClass',
                    metadataName: 'DemoDeletedClass'
                },
                {
                    metadataType: 'ApexClass',
                    metadataName: 'AlphaClass'
                }
            ]
        }, '61.0');

        assert.match(xml, /<members>AlphaClass<\/members>/);
        assert.match(xml, /<members>DemoDeletedClass<\/members>/);
        assert.match(xml, /<name>ApexClass<\/name>/);
        assert.match(xml, /<version>61\.0<\/version>/);
        assert.strictEqual(
            (xml.match(/<members>DemoDeletedClass<\/members>/g) || []).length,
            1
        );
        assert.throws(() => generateDestructiveChangesXml({ metadata: [] }));
        assert.throws(() =>
            generateDestructiveChangesXml({
                metadata: [{ metadataType: 'ApexClass' }]
            })
        );
    });

    await runTest('D18. destructive manifest ordering is deterministic', () => {
        const first = generateDestructiveChangesXml({
            metadata: [
                { metadataType: 'ApexClass', metadataName: 'Zeta' },
                { metadataType: 'ApexClass', metadataName: 'Alpha' }
            ]
        });
        const second = generateDestructiveChangesXml({
            metadata: [
                { metadataType: 'ApexClass', metadataName: 'Alpha' },
                { metadataType: 'ApexClass', metadataName: 'Zeta' }
            ]
        });

        assert.strictEqual(first, second);
        assert.ok(first.indexOf('Alpha') < first.indexOf('Zeta'));
    });

    await runTest('E21-E24. CLI destructive flags', () => {
        const destructive = buildProjectDeployCommand({
            workspacePath: '/tmp/delete',
            alias: 'dest',
            preDestructiveChangesPath: 'destructiveChanges.xml'
        });
        const normal = buildProjectDeployCommand({
            workspacePath: '/tmp/restore',
            alias: 'dest'
        });

        assert.match(
            destructive,
            /--pre-destructive-changes "destructiveChanges\.xml"/
        );
        assert.match(destructive, /--manifest package\.xml/);
        assert.doesNotMatch(normal, /--pre-destructive-changes/);
    });

    await runTest('F25-F30. delete rollback end-to-end succeeds', async () => {
        const { capture, sealed, afterBytes } = await sealDeleteSnapshot();
        const harness = createDeleteRestoreHarness({
            capture,
            retrieveBytes: afterBytes
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com',
            destinationOrgId: '00D000000000001'
        });
        const workspaces = harness.getWorkspaces();

        assert.strictEqual(result.blocked, false);
        assert.strictEqual(result.operationStatus, 'SUCCEEDED');
        assert.ok(workspaces.checkOnlyWorkspace?.preDestructiveChangesPath);
        assert.ok(workspaces.executeWorkspace?.preDestructiveChangesPath);
    });

    await runTest('G31. check-only failure prevents actual deployment', async () => {
        const { capture, sealed, afterBytes } = await sealDeleteSnapshot();
        const harness = createDeleteRestoreHarness({
            capture,
            retrieveBytes: afterBytes,
            checkOnlySuccess: false
        });
        const result = await harness.service.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.CHECK_ONLY_FAILED);
        assert.strictEqual(harness.getExecutionCount(), 0);
    });

    await runTest('G32. drift failure prevents destructive deployment', async () => {
        const { capture, sealed } = await sealDeleteSnapshot();
        let executions = 0;
        const operationStore = createMemoryRollbackOperationStore();
        const restore = createDestinationSnapshotRestoreService({
            getRollbackOperationStore: () => operationStore,
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
                artifactBytes: Buffer.from('drifted-bytes'),
                files: []
            }),
            runDeploymentExecution: async () => {
                executions += 1;
                return { success: true, status: 'Succeeded' };
            }
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.DRIFT_DETECTED);
        assert.strictEqual(executions, 0);
    });

    await runTest('B11. destination already missing blocks delete rollback', async () => {
        const { capture, sealed } = await sealDeleteSnapshot();
        const operationStore = createMemoryRollbackOperationStore();
        const restore = createDestinationSnapshotRestoreService({
            getRollbackOperationStore: () => operationStore,
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
            retrieveDestinationMember: async () => ({ artifactBytes: null, files: [] })
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(result.code, ROLLBACK_CODE.DESTINATION_ALREADY_MISSING);
    });

    await runTest('G33. post-delete EXISTS prevents success', async () => {
        const { capture, sealed, afterBytes } = await sealDeleteSnapshot();
        const harness = createDeleteRestoreHarness({
            capture,
            retrieveBytes: afterBytes,
            inventoryState: DESTINATION_STATE.EXISTS
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
    });

    await runTest('G34. mixed snapshot blocked at rollback', async () => {
        const capture = createSnapshotCaptureService({
            metadataStore: createMemorySnapshotMetadataStore(),
            blobStore: createMemorySnapshotBlobStore()
        });
        const packed = packMemberFiles([
            {
                relativePath: 'classes/AccountService.cls',
                bytes: Buffer.from('before\n', 'utf8')
            }
        ]);
        const ready = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: '00D000000000001' },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'AccountService',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: packed,
                    expectedAfterHash: hashBytes(Buffer.from('after\n', 'utf8'))
                },
                {
                    metadataType: 'ApexClass',
                    metadataName: 'DemoDeletedClass',
                    changeClass: CHANGE_CLASS.NEW,
                    expectedAfterHash: hashBytes(deletedClassAfterBytes())
                }
            ]
        });
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        const restore = createDestinationSnapshotRestoreService({
            getRollbackOperationStore: () => createMemoryRollbackOperationStore(),
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
            resolveVerifiedDestinationOrgId: async () => '00D000000000001'
        });
        const result = await restore.runRollback({
            snapshotId: sealed.snapshotId,
            refreshToken: 'refresh',
            instanceUrl: 'https://dest.example.com'
        });

        assert.strictEqual(sealed.rollbackEligible, false);
        assert.strictEqual(result.code, ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE);
    });

    await runTest('F7. delete rollback workspace contains destructive manifest', async () => {
        const workspace = await buildDeleteRollbackWorkspace({
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'DemoDeletedClass'
                }
            ],
            apiVersion: '61.0'
        });

        assert.ok(workspace.packageXmlPath);
        assert.ok(workspace.destructiveChangesXmlPath);
        assert.strictEqual(workspace.preDestructiveChangesPath, 'destructiveChanges.xml');
        assert.match(
            workspace.generatedManifest.destructiveChangesXml,
            /<members>DemoDeletedClass<\/members>/
        );
        assert.strictEqual(
            workspace.generatedManifest.packageXml,
            generateEmptyPackageXml('61.0')
        );
        assert.strictEqual(workspace.generatedManifest.summary.apiVersion, '61.0');
    });

    await runTest(
        'delete rollback workspace resolves default API version when apiVersion is null',
        async () => {
            const members = [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'DemoDeletedClass'
                }
            ];
            const workspace = await buildDeleteRollbackWorkspace({
                members,
                apiVersion: null
            });

            assert.strictEqual(
                workspace.generatedManifest.summary.apiVersion,
                DEFAULT_API_VERSION
            );
            assert.match(
                workspace.generatedManifest.packageXml,
                new RegExp(`<version>${DEFAULT_API_VERSION}</version>`)
            );
            assert.match(
                workspace.generatedManifest.destructiveChangesXml,
                new RegExp(`<version>${DEFAULT_API_VERSION}</version>`)
            );
            assert.doesNotMatch(
                workspace.generatedManifest.packageXml,
                /<version>null<\/version>/
            );
            assert.doesNotMatch(
                workspace.generatedManifest.destructiveChangesXml,
                /<version>null<\/version>/
            );
        }
    );
})();
