'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    SNAPSHOT_STATUS
} = require('./snapshot.types');
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
    createSnapshotExportService,
    maybeAttachSnapshotExport
} = require('./snapshotExport.service');
const {
    SNAPSHOT_EXPORT_ERROR_CODE
} = require('./snapshotExport.errors');
const {
    createDestinationSnapshotCaptureService
} = require('./destinationSnapshotCapture.service');
const {
    isSnapshotCaptureOnDeployEnabled
} = require('./snapshotCapture.flag');
const {
    SnapshotAlreadySealedError
} = require('./snapshot.errors');
const {
    getSnapshotArtifact
} = require('../../controllers/deploymentSnapshotArtifact.controller');

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

function createSealedSnapshotHarness() {
    const metadataStore = createMemorySnapshotMetadataStore();
    const blobStore = createMemorySnapshotBlobStore();
    const captureService = createSnapshotCaptureService({
        metadataStore,
        blobStore
    });
    const exportService = createSnapshotExportService({
        getSharedSnapshotAccess: () => ({
            getSnapshot: (snapshotId) => captureService.getSnapshot(snapshotId),
            getMembers: (snapshotId) => captureService.getMembers(snapshotId),
            getArtifact: (snapshotId, artifactId) =>
                captureService.getArtifact(snapshotId, artifactId)
        })
    });

    return { metadataStore, blobStore, captureService, exportService };
}

async function createModifiedSealedSnapshot(captureService, options = {}) {
    const beforeBytes = options.beforeBytes || Buffer.from('class Old {}');
    const afterHash =
        options.expectedAfterHash ||
        hashBytes(Buffer.from('class New {}'));

    const ready = await captureService.captureSnapshot({
        deploymentContext: {
            destinationOrgId: options.destinationOrgId || '00D000000000001AA',
            sourceOrgId: options.sourceOrgId || null,
            deploymentId: options.deploymentId || 'history_20260827_001',
            sourceBranch: 'source/main',
            destinationBranch: 'dest/main'
        },
        members: [
            {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: 'classes/AccountService.cls',
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: beforeBytes,
                expectedAfterHash: afterHash
            }
        ]
    });

    assert.strictEqual(ready.status, SNAPSHOT_STATUS.READY);

    return captureService.sealSnapshot(ready.snapshotId);
}

function mockResponse() {
    const state = {
        statusCode: null,
        headers: {},
        body: null
    };

    return {
        state,
        res: {
            status(code) {
                state.statusCode = code;
                return this;
            },
            set(key, value) {
                state.headers[key] = value;
                return this;
            },
            send(body) {
                state.body = body;
                return this;
            },
            json(body) {
                state.body = body;
                return this;
            }
        }
    };
}

(async () => {
    await runTest('1. flag OFF path leaves response unchanged (no snapshotExport)', async () => {
        assert.strictEqual(isSnapshotCaptureOnDeployEnabled(), false);

        const response = {
            deploymentHistory: {
                historyId: 'history_20260827_001',
                snapshotId: null,
                status: 'SUCCESS'
            }
        };

        await maybeAttachSnapshotExport(response, null);

        assert.strictEqual(response.snapshotExport, undefined);
        assert.strictEqual(response.snapshotExportError, undefined);
    });

    await runTest('2. capture enabled deploy path exposes snapshotExport metadata', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const sealed = await createModifiedSealedSnapshot(captureService);

        const response = {
            deploymentHistory: {
                historyId: sealed.deploymentId,
                snapshotId: sealed.snapshotId,
                status: 'SUCCESS'
            }
        };

        await maybeAttachSnapshotExport(response, sealed, { exportService });

        assert.ok(response.snapshotExport);
        assert.strictEqual(response.snapshotExport.snapshotId, sealed.snapshotId);
        assert.strictEqual(response.snapshotExport.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(response.snapshotExport.members.length, 1);
    });

    await runTest('3. snapshotExport contains header, members, hashes, artifact metadata', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const sealed = await createModifiedSealedSnapshot(captureService);
        const response = {};

        await maybeAttachSnapshotExport(response, sealed, { exportService });
        const exported = response.snapshotExport;

        assert.strictEqual(exported.deploymentId, 'history_20260827_001');
        assert.strictEqual(exported.destinationOrgId, '00D000000000001AA');
        assert.ok(exported.overallIntegrityHash);
        assert.strictEqual(typeof exported.rollbackEligible, 'boolean');
        assert.ok(exported.sealedAt);

        const member = exported.members[0];
        assert.strictEqual(member.metadataType, 'ApexClass');
        assert.strictEqual(member.metadataName, 'AccountService');
        assert.strictEqual(member.changeClass, CHANGE_CLASS.MODIFIED);
        assert.strictEqual(member.existedBefore, true);
        assert.ok(member.destinationBeforeHash);
        assert.ok(member.expectedAfterHash);
        assert.ok(member.artifactId);
        assert.ok(member.artifactSize > 0);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.COMPLETE);
    });

    await runTest('4. NEW member export has metadata without destination-before artifact', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();

        const ready = await captureService.captureSnapshot({
            deploymentContext: {
                destinationOrgId: '00D000000000001AA',
                deploymentId: 'history_new_only'
            },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'CreatedOnly',
                    changeClass: CHANGE_CLASS.NEW
                }
            ]
        });

        const sealed = await captureService.sealSnapshot(ready.snapshotId);
        const response = {};

        await maybeAttachSnapshotExport(response, sealed, { exportService });

        const member = response.snapshotExport.members[0];
        assert.strictEqual(member.changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(member.existedBefore, false);
        assert.strictEqual(member.artifactId, null);
        assert.strictEqual(member.destinationBeforeHash, null);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
        assert.strictEqual(response.snapshotExport.rollbackEligible, false);
    });

    await runTest('5. MODIFIED member export includes artifact metadata', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const sealed = await createModifiedSealedSnapshot(captureService);
        const response = {};

        await maybeAttachSnapshotExport(response, sealed, { exportService });
        const member = response.snapshotExport.members[0];

        assert.match(member.artifactId, /^snapshots\//);
        assert.ok(member.artifactSize > 0);
    });

    await runTest('6. artifact endpoint returns exact bytes', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const beforeBytes = Buffer.from('class ExactBytes {}');
        const sealed = await createModifiedSealedSnapshot(captureService, {
            beforeBytes
        });
        const member = (await captureService.getMembers(sealed.snapshotId))[0];

        const bytes = await exportService.retrieveSnapshotArtifact({
            snapshotId: sealed.snapshotId,
            artifactId: member.artifactId,
            historyId: sealed.deploymentId
        });

        assert.ok(Buffer.isBuffer(bytes));
        assert.strictEqual(bytes.toString('utf8'), beforeBytes.toString('utf8'));
    });

    await runTest('7. artifact endpoint preserves binary bytes 00 01 FF 0A 0D', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const binary = Buffer.from([0x00, 0x01, 0xff, 0x0a, 0x0d]);
        const sealed = await createModifiedSealedSnapshot(captureService, {
            beforeBytes: binary
        });
        const member = (await captureService.getMembers(sealed.snapshotId))[0];

        const bytes = await exportService.retrieveSnapshotArtifact({
            snapshotId: sealed.snapshotId,
            artifactId: member.artifactId,
            historyId: sealed.deploymentId
        });

        assert.deepStrictEqual(Array.from(bytes), [0, 1, 255, 10, 13]);
    });

    await runTest('8. cross-snapshot artifact access is rejected', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const sealedA = await createModifiedSealedSnapshot(captureService, {
            deploymentId: 'history_a'
        });
        const sealedB = await createModifiedSealedSnapshot(captureService, {
            deploymentId: 'history_b'
        });
        const memberA = (await captureService.getMembers(sealedA.snapshotId))[0];

        await assert.rejects(
            () =>
                exportService.retrieveSnapshotArtifact({
                    snapshotId: sealedB.snapshotId,
                    artifactId: memberA.artifactId,
                    historyId: sealedB.deploymentId
                }),
            (error) =>
                error.code === SNAPSHOT_EXPORT_ERROR_CODE.ARTIFACT_NOT_FOUND
        );
    });

    await runTest('9. invalid artifact returns NOT_FOUND', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const sealed = await createModifiedSealedSnapshot(captureService);
        const member = (await captureService.getMembers(sealed.snapshotId))[0];

        await assert.rejects(
            () =>
                exportService.retrieveSnapshotArtifact({
                    snapshotId: sealed.snapshotId,
                    artifactId: member.artifactId.replace(
                        'AccountService',
                        'MissingClass'
                    ),
                    historyId: sealed.deploymentId
                }),
            (error) =>
                error.code === SNAPSHOT_EXPORT_ERROR_CODE.ARTIFACT_NOT_FOUND
        );
    });

    await runTest('10. path traversal artifactId is rejected', async () => {
        const { captureService, exportService } = createSealedSnapshotHarness();
        const sealed = await createModifiedSealedSnapshot(captureService);

        await assert.rejects(
            () =>
                exportService.retrieveSnapshotArtifact({
                    snapshotId: sealed.snapshotId,
                    artifactId: `snapshots/${sealed.snapshotId}/destination-before/ApexClass/../Secret`,
                    historyId: sealed.deploymentId
                }),
            (error) =>
                error.code === SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST
        );
    });

    await runTest('11. sealed snapshot cannot be modified', async () => {
        const { captureService } = createSealedSnapshotHarness();
        const sealed = await createModifiedSealedSnapshot(captureService);

        await assert.rejects(
            () =>
                captureService.addMember(sealed.snapshotId, {
                    metadataType: 'ApexClass',
                    metadataName: 'AnotherClass',
                    changeClass: CHANGE_CLASS.NEW
                }),
            SnapshotAlreadySealedError
        );
    });

    await runTest('12. errors do not expose credentials/tokens', async () => {
        const { exportService } = createSnapshotExportService({
            getSharedSnapshotAccess: () => ({
                getSnapshot: async () => {
                    throw new Error(
                        'refreshToken=secret accessToken=secret Authorization=Bearer abc'
                    );
                },
                getMembers: async () => [],
                getArtifact: async () => null
            })
        });

        try {
            await exportService.buildSnapshotExport('snapshot_test');
            assert.fail('expected export failure');
        } catch (error) {
            assert.ok(error.message);
            assert.ok(!/refreshToken/i.test(error.message));
            assert.ok(!/accessToken/i.test(error.message));
            assert.ok(!/Authorization/i.test(error.message));
        }
    });

    await runTest('13. HTTP artifact endpoint returns binary response', async () => {
        const {
            getSharedSnapshotAccess,
            resetSharedSnapshotAccessForTests
        } = require('./snapshotAccess.service');

        resetSharedSnapshotAccessForTests();
        const captureService = getSharedSnapshotAccess().captureService;
        const binary = Buffer.from([0x00, 0x01, 0xff, 0x0a, 0x0d]);

        const ready = await captureService.captureSnapshot({
            deploymentContext: {
                destinationOrgId: '00D000000000001AA',
                deploymentId: 'history_http_binary'
            },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'BinaryClass',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: binary,
                    expectedAfterHash: hashBytes(Buffer.from('after'))
                }
            ]
        });
        const sealed = await captureService.sealSnapshot(ready.snapshotId);
        const member = (await captureService.getMembers(sealed.snapshotId))[0];
        const { state, res } = mockResponse();

        await getSnapshotArtifact(
            {
                query: {
                    snapshotId: sealed.snapshotId,
                    artifactId: member.artifactId,
                    historyId: sealed.deploymentId
                }
            },
            res
        );

        assert.strictEqual(state.statusCode, 200);
        assert.strictEqual(
            state.headers['Content-Type'],
            'application/octet-stream'
        );
        assert.deepStrictEqual(Array.from(state.body), [0, 1, 255, 10, 13]);
    });

    await runTest('14. orchestrator with capture ON still seals before deploy execution', async () => {
        const metadataStore = createMemorySnapshotMetadataStore();
        const blobStore = createMemorySnapshotBlobStore();
        const innerCapture = createSnapshotCaptureService({
            metadataStore,
            blobStore
        });
        const events = [];

        const captureService = {
            captureSnapshot: (...args) => innerCapture.captureSnapshot(...args),
            sealSnapshot: async (snapshotId) => {
                events.push('seal');
                return innerCapture.sealSnapshot(snapshotId);
            },
            getSnapshot: (...args) => innerCapture.getSnapshot(...args),
            getMembers: (...args) => innerCapture.getMembers(...args),
            getArtifact: (...args) => innerCapture.getArtifact(...args)
        };

        const service = createDestinationSnapshotCaptureService({
            captureService,
            isSnapshotCaptureOnDeployEnabled: () => true,
            enforceDurableCapture: false,
            refreshAccessToken: async () => ({
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com'
            }),
            buildDestinationInventory: async ({ items }) => ({
                inventory: new Map(
                    items.map((item) => [
                        `${item.metadataType}:${item.metadataName}`,
                        { state: 'EXISTS' }
                    ])
                )
            }),
            retrieveDestinationMember: async () => ({
                artifactBytes: Buffer.from('class Old {}')
            }),
            collectExpectedAfterArtifact: async () => ({
                expectedAfterHash: hashBytes(Buffer.from('class New {}'))
            })
        });

        let deployStarted = false;

        const result = await service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: {
                destinationOrgId: '00D000000000001AA',
                historyId: 'history_orchestrator',
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'AccountService'
                        }
                    ]
                },
                generatedWorkspace: { workspacePath: '/tmp/ws' },
                refreshToken: 'refresh-secret',
                instanceUrl: 'https://dest.example.com'
            },
            runDeploymentExecution: async () => {
                deployStarted = true;
                assert.deepStrictEqual(events, ['seal']);
                return { success: true, status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployStarted, true);
        assert.strictEqual(result.snapshot.status, SNAPSHOT_STATUS.SEALED);

        const response = {};
        const exportService = createSnapshotExportService({
            getSharedSnapshotAccess: () => ({
                getSnapshot: (snapshotId) =>
                    captureService.getSnapshot(snapshotId),
                getMembers: (snapshotId) => captureService.getMembers(snapshotId),
                getArtifact: (snapshotId, artifactId) =>
                    captureService.getArtifact(snapshotId, artifactId)
            })
        });
        await maybeAttachSnapshotExport(response, result.snapshot, {
            exportService
        });
        assert.ok(response.snapshotExport);
        assert.strictEqual(
            response.snapshotExport.snapshotId,
            result.snapshot.snapshotId
        );
    });
})();
