'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    SNAPSHOT_STATUS
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE,
    SalesforceRollbackSnapshotContextError,
    createSalesforceRollbackSnapshotContext,
    normalizeCaptureStatus
} = require('./salesforceRollbackSnapshotContext.service');

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

function assertRejects(promise, { code, messageIncludes }) {
    return promise
        .then(() => {
            assert.fail('Expected rejection');
        })
        .catch((error) => {
            assert.ok(error instanceof SalesforceRollbackSnapshotContextError);
            assert.strictEqual(error.code, code);

            if (messageIncludes) {
                assert.ok(
                    error.message.includes(messageIncludes),
                    `Expected message to include "${messageIncludes}", got "${error.message}"`
                );
            }
        });
}

const SNAPSHOT_ID = 'snapshot_89df94c0-ddaa-47fa-be6b-43a07cf03e47';
const ARTIFACT_ID = `snapshots/${SNAPSHOT_ID}/destination-before/ApexClass/DemoModifiedClass`;

function buildArtifactBytes(label = 'before') {
    return packMemberFiles([
        {
            relativePath:
                'force-app/main/default/classes/DemoModifiedClass.cls',
            bytes: Buffer.from(
                `public class DemoModifiedClass {\n    // ${label}\n}\n`,
                'utf8'
            )
        }
    ]);
}

function buildSnapshotExport(overrides = {}) {
    const artifactBytes = overrides.artifactBytes || buildArtifactBytes();
    const destinationBeforeHash =
        overrides.destinationBeforeHash || hashBytes(artifactBytes);

    const member = {
        memberKey: 'ApexClass:DemoModifiedClass',
        metadataType: 'ApexClass',
        metadataName: 'DemoModifiedClass',
        filePath: 'force-app/main/default/classes/DemoModifiedClass.cls',
        changeClass: CHANGE_CLASS.MODIFIED,
        existedBefore: true,
        destinationBeforeHash,
        expectedAfterHash:
            overrides.expectedAfterHash ||
            hashBytes(buildArtifactBytes('after')),
        artifactId: ARTIFACT_ID,
        artifactSize: artifactBytes.length,
        contentDocumentId: '069NS00000dtlPdYAI',
        captureStatus: 'CAPTURED',
        ...overrides.member
    };

    return {
        snapshotExport: {
            snapshotId: SNAPSHOT_ID,
            deploymentId: 'history-001',
            sourceOrgId: '00D000000000002',
            destinationOrgId: '00D000000000001',
            sourceBranch: 'feature/demo',
            destinationBranch: 'main',
            status: SNAPSHOT_STATUS.SEALED,
            schemaVersion: 2,
            snapshotVersion: 1,
            overallIntegrityHash: overrides.overallIntegrityHash || null,
            rollbackEligible: true,
            createdAt: '2026-08-31T00:00:00.000Z',
            completedAt: '2026-08-31T00:01:00.000Z',
            sealedAt: '2026-08-31T00:01:00.000Z',
            memberCount: 1,
            members: [member],
            ...overrides.snapshotExport
        },
        artifactBytes,
        member
    };
}

function buildArtifactsMap(artifactBytes, artifactId = ARTIFACT_ID) {
    return {
        [artifactId]: {
            contentBase64: artifactBytes.toString('base64'),
            size: artifactBytes.length
        }
    };
}

(async () => {
    await runTest('valid snapshotExport creates a captureService', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();
        const context = await createSalesforceRollbackSnapshotContext(
            snapshotExport,
            buildArtifactsMap(artifactBytes)
        );

        assert.ok(context.captureService);
        assert.strictEqual(typeof context.captureService.getSnapshot, 'function');
        assert.strictEqual(context.snapshotId, SNAPSHOT_ID);
    });

    await runTest('captureService.getSnapshot returns stored snapshot', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();
        const { captureService } = await createSalesforceRollbackSnapshotContext(
            snapshotExport,
            buildArtifactsMap(artifactBytes)
        );

        const snapshot = await captureService.getSnapshot(SNAPSHOT_ID);

        assert.strictEqual(snapshot.snapshotId, SNAPSHOT_ID);
        assert.strictEqual(snapshot.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(snapshot.rollbackEligible, true);
    });

    await runTest('captureService.getMembers returns stored members', async () => {
        const { snapshotExport, artifactBytes, member } = buildSnapshotExport();
        const { captureService } = await createSalesforceRollbackSnapshotContext(
            snapshotExport,
            buildArtifactsMap(artifactBytes)
        );

        const members = await captureService.getMembers(SNAPSHOT_ID);

        assert.strictEqual(members.length, 1);
        assert.strictEqual(members[0].metadataType, member.metadataType);
        assert.strictEqual(members[0].metadataName, member.metadataName);
        assert.strictEqual(members[0].artifactId, ARTIFACT_ID);
    });

    await runTest('CAPTURED becomes COMPLETE on stored members', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();
        const { captureService } = await createSalesforceRollbackSnapshotContext(
            snapshotExport,
            buildArtifactsMap(artifactBytes)
        );

        const members = await captureService.getMembers(SNAPSHOT_ID);

        assert.strictEqual(members[0].captureStatus, MEMBER_CAPTURE_STATUS.COMPLETE);
        assert.strictEqual(normalizeCaptureStatus('CAPTURED'), MEMBER_CAPTURE_STATUS.COMPLETE);
    });

    await runTest('MODIFIED member artifact is retrievable as Buffer', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();
        const { captureService } = await createSalesforceRollbackSnapshotContext(
            snapshotExport,
            buildArtifactsMap(artifactBytes)
        );

        const bytes = await captureService.getArtifact(SNAPSHOT_ID, ARTIFACT_ID);

        assert.ok(Buffer.isBuffer(bytes));
        assert.ok(bytes.length > 0);
    });

    await runTest('retrieved artifact bytes match decoded input byte-for-byte', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();
        const { captureService } = await createSalesforceRollbackSnapshotContext(
            snapshotExport,
            buildArtifactsMap(artifactBytes)
        );

        const bytes = await captureService.getArtifact(SNAPSHOT_ID, ARTIFACT_ID);

        assert.ok(bytes.equals(artifactBytes));
    });

    await runTest('missing snapshotExport fails', async () => {
        await assertRejects(createSalesforceRollbackSnapshotContext(null, {}), {
            code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
            messageIncludes: 'snapshotExport is required'
        });
    });

    await runTest('missing snapshotId fails', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();

        await assertRejects(
            createSalesforceRollbackSnapshotContext(
                { ...snapshotExport, snapshotId: '' },
                buildArtifactsMap(artifactBytes)
            ),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
                messageIncludes: 'snapshotId is required'
            }
        );
    });

    await runTest('missing members array fails', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();

        await assertRejects(
            createSalesforceRollbackSnapshotContext(
                { ...snapshotExport, members: undefined },
                buildArtifactsMap(artifactBytes)
            ),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
                messageIncludes: 'members must be an array'
            }
        );
    });

    await runTest('missing artifacts map fails', async () => {
        const { snapshotExport } = buildSnapshotExport();

        await assertRejects(
            createSalesforceRollbackSnapshotContext(snapshotExport, null),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
                messageIncludes: 'artifacts map is required'
            }
        );
    });

    await runTest('MODIFIED member missing artifactId fails', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport({
            member: { artifactId: null }
        });

        await assertRejects(
            createSalesforceRollbackSnapshotContext(
                snapshotExport,
                buildArtifactsMap(artifactBytes)
            ),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_MISSING,
                messageIncludes: 'missing artifactId'
            }
        );
    });

    await runTest('artifactId absent from artifacts map fails', async () => {
        const { snapshotExport } = buildSnapshotExport();

        await assertRejects(
            createSalesforceRollbackSnapshotContext(snapshotExport, {}),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_MISSING,
                messageIncludes: 'not supplied'
            }
        );
    });

    await runTest('missing contentBase64 fails', async () => {
        const { snapshotExport } = buildSnapshotExport();

        await assertRejects(
            createSalesforceRollbackSnapshotContext(snapshotExport, {
                [ARTIFACT_ID]: { size: 10 }
            }),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID,
                messageIncludes: 'missing contentBase64'
            }
        );
    });

    await runTest('invalid or empty artifact bytes fail', async () => {
        const { snapshotExport } = buildSnapshotExport();

        await assertRejects(
            createSalesforceRollbackSnapshotContext(snapshotExport, {
                [ARTIFACT_ID]: {
                    contentBase64: '!!!not-base64!!!',
                    size: 1
                }
            }),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID
            }
        );

        await assertRejects(
            createSalesforceRollbackSnapshotContext(snapshotExport, {
                [ARTIFACT_ID]: {
                    contentBase64: '',
                    size: 0
                }
            }),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID
            }
        );
    });

    await runTest('supplied size mismatch fails', async () => {
        const { snapshotExport, artifactBytes } = buildSnapshotExport();

        await assertRejects(
            createSalesforceRollbackSnapshotContext(
                snapshotExport,
                {
                    [ARTIFACT_ID]: {
                        contentBase64: artifactBytes.toString('base64'),
                        size: artifactBytes.length + 1
                    }
                }
            ),
            {
                code: SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_SIZE_MISMATCH,
                messageIncludes: 'does not match decoded byte length'
            }
        );
    });

    await runTest('multiple artifacts remain isolated by artifactId', async () => {
        const firstBytes = buildArtifactBytes('first');
        const secondBytes = buildArtifactBytes('second');
        const secondArtifactId = `snapshots/${SNAPSHOT_ID}/destination-before/ApexClass/SecondClass`;

        const { snapshotExport } = buildSnapshotExport();
        snapshotExport.members.push({
            memberKey: 'ApexClass:SecondClass',
            metadataType: 'ApexClass',
            metadataName: 'SecondClass',
            filePath: 'force-app/main/default/classes/SecondClass.cls',
            changeClass: CHANGE_CLASS.MODIFIED,
            existedBefore: true,
            destinationBeforeHash: hashBytes(secondBytes),
            expectedAfterHash: hashBytes(buildArtifactBytes('second-after')),
            artifactId: secondArtifactId,
            artifactSize: secondBytes.length,
            contentDocumentId: '069NS00000dtlPdYAI',
            captureStatus: 'CAPTURED'
        });
        snapshotExport.memberCount = 2;

        const { captureService } = await createSalesforceRollbackSnapshotContext(
            snapshotExport,
            {
                [ARTIFACT_ID]: {
                    contentBase64: firstBytes.toString('base64'),
                    size: firstBytes.length
                },
                [secondArtifactId]: {
                    contentBase64: secondBytes.toString('base64'),
                    size: secondBytes.length
                }
            }
        );

        const first = await captureService.getArtifact(SNAPSHOT_ID, ARTIFACT_ID);
        const second = await captureService.getArtifact(
            SNAPSHOT_ID,
            secondArtifactId
        );

        assert.ok(first.equals(firstBytes));
        assert.ok(second.equals(secondBytes));
        assert.notDeepStrictEqual(first, second);
    });

    await runTest('no filesystem or durable storage is used', async () => {
        const durableRoot = path.join(
            os.tmpdir(),
            `rollback-context-test-${Date.now()}`
        );
        const previousRoot = process.env.SNAPSHOT_DURABLE_ROOT;
        const previousMode = process.env.SNAPSHOT_STORAGE_MODE;

        process.env.SNAPSHOT_DURABLE_ROOT = durableRoot;
        process.env.SNAPSHOT_STORAGE_MODE = 'DURABLE';

        try {
            const { snapshotExport, artifactBytes } = buildSnapshotExport();
            const { blobStore } = await createSalesforceRollbackSnapshotContext(
                snapshotExport,
                buildArtifactsMap(artifactBytes)
            );

            assert.strictEqual(
                blobStore.constructor,
                createMemorySnapshotBlobStore().constructor
            );
            assert.strictEqual(
                fs.existsSync(path.join(durableRoot, 'artifacts')),
                false
            );
        } finally {
            if (previousRoot === undefined) {
                delete process.env.SNAPSHOT_DURABLE_ROOT;
            } else {
                process.env.SNAPSHOT_DURABLE_ROOT = previousRoot;
            }

            if (previousMode === undefined) {
                delete process.env.SNAPSHOT_STORAGE_MODE;
            } else {
                process.env.SNAPSHOT_STORAGE_MODE = previousMode;
            }
        }
    });
})();
