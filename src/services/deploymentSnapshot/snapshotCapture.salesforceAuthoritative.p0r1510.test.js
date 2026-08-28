'use strict';

const assert = require('assert');

const { SNAPSHOT_STATUS } = require('./snapshot.types');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    createDestinationSnapshotCaptureService
} = require('./destinationSnapshotCapture.service');
const {
    maybeAttachSnapshotExport,
    retrieveSnapshotArtifact
} = require('./snapshotExport.service');
const {
    resetSharedSnapshotAccessForTests
} = require('./snapshotAccess.service');
const {
    STORAGE_MODE_ENV,
    DURABLE_ROOT_ENV
} = require('./snapshotStorage.config');
const { FLAG_ENV } = require('./snapshotCapture.flag');

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

function restoreEnv(previous) {
    Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    });
    resetSharedSnapshotAccessForTests();
}

(async () => {
    await runTest(
        'Salesforce-authoritative capture works with MEMORY storage',
        async () => {
            const previous = {
                [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
                [DURABLE_ROOT_ENV]: process.env[DURABLE_ROOT_ENV],
                [FLAG_ENV]: process.env[FLAG_ENV]
            };

            delete process.env[STORAGE_MODE_ENV];
            delete process.env[DURABLE_ROOT_ENV];
            delete process.env[FLAG_ENV];
            resetSharedSnapshotAccessForTests();

            try {
                const service = createDestinationSnapshotCaptureService({
                    isSnapshotCaptureOnDeployEnabled: () => true,
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
                        historyId: 'history_p0r1510',
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'ApexClass',
                                    metadataName: 'AccountService',
                                    filePath: 'classes/AccountService.cls'
                                }
                            ]
                        },
                        generatedWorkspace: { workspacePath: '/tmp/ws' },
                        refreshToken: 'refresh-secret',
                        instanceUrl: 'https://dest.example.com'
                    },
                    runDeploymentExecution: async () => {
                        deployStarted = true;
                        return { success: true, status: 'SUCCESS' };
                    }
                });

                assert.strictEqual(deployStarted, true);
                assert.strictEqual(result.snapshotBlocked, false);
                assert.ok(result.snapshot);
                assert.strictEqual(result.snapshot.status, SNAPSHOT_STATUS.SEALED);

                const response = {};
                await maybeAttachSnapshotExport(response, result.snapshot);

                assert.ok(response.snapshotExport);
                assert.strictEqual(
                    response.snapshotExport.status,
                    SNAPSHOT_STATUS.SEALED
                );
                assert.strictEqual(
                    response.snapshotExport.snapshotId,
                    result.snapshot.snapshotId
                );
                assert.ok(response.snapshotExport.members.length >= 1);

                const member = response.snapshotExport.members.find(
                    (row) => row.metadataName === 'AccountService'
                );
                assert.ok(member);
                assert.ok(member.artifactId);

                const bytes = await retrieveSnapshotArtifact({
                    snapshotId: result.snapshot.snapshotId,
                    artifactId: member.artifactId,
                    historyId: 'history_p0r1510'
                });

                assert.ok(bytes.length > 0);
            } finally {
                restoreEnv(previous);
            }
        }
    );
})();
