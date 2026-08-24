'use strict';

const assert = require('assert');

const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    SNAPSHOT_STATUS,
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
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
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const {
    createDestinationSnapshotCaptureService
} = require('./destinationSnapshotCapture.service');

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

function inventoryFor(members) {
    const inventory = new Map();

    for (const member of members) {
        inventory.set(`${member.metadataType}:${member.metadataName}`, {
            state: member.state
        });
    }

    return { inventory };
}

function createHarness(overrides = {}) {
    const metadataStore = createMemorySnapshotMetadataStore();
    const blobStore = createMemorySnapshotBlobStore();
    const innerCapture = createSnapshotCaptureService({
        metadataStore,
        blobStore
    });
    const events = [];
    const retrieveCalls = [];
    const inventoryCalls = [];

    const captureService = {
        captureSnapshot: (...args) => innerCapture.captureSnapshot(...args),
        sealSnapshot: async (snapshotId) => {
            events.push('seal');
            return innerCapture.sealSnapshot(snapshotId);
        },
        getSnapshot: (...args) => innerCapture.getSnapshot(...args),
        getMembers: (...args) => innerCapture.getMembers(...args)
    };

    const service = createDestinationSnapshotCaptureService({
        captureService,
        isSnapshotCaptureOnDeployEnabled:
            overrides.isEnabled || (() => true),
        refreshAccessToken:
            overrides.refreshAccessToken ||
            (async () => ({
                accessToken: 'token',
                instanceUrl: 'https://dest.example.com'
            })),
        buildDestinationInventory:
            overrides.buildDestinationInventory ||
            (async (args) => {
                inventoryCalls.push(args);
                return inventoryFor(
                    (args.items || []).map((item) => ({
                        ...item,
                        state: DESTINATION_STATE.EXISTS
                    }))
                );
            }),
        retrieveDestinationMember:
            overrides.retrieveDestinationMember ||
            (async (args) => {
                retrieveCalls.push(args);
                const bytes = packMemberFiles([
                    {
                        relativePath: 'classes/AccountService.cls',
                        bytes: Buffer.from('destination-before\r\n', 'utf8')
                    }
                ]);
                return { artifactBytes: bytes, files: [] };
            })
    });

    return {
        service,
        events,
        retrieveCalls,
        inventoryCalls,
        blobStore,
        captureService
    };
}

const BASE_ARGS = {
    destinationOrgId: '00D000000000001',
    sourceOrgId: '00D000000000002',
    historyId: 'hist-1',
    sourceBranch: 'feature',
    destinationBranch: 'main',
    refreshToken: 'refresh-secret',
    instanceUrl: 'https://dest.example.com',
    generatedDeploymentPackage: {
        selectedMetadata: [
            { metadataType: 'ApexClass', metadataName: 'ShouldIgnore' }
        ],
        metadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: 'classes/AccountService.cls'
            }
        ]
    }
};

(async () => {
    await runTest('flag OFF skips snapshot and deploys unchanged', async () => {
        const harness = createHarness({ isEnabled: () => false });
        let deployed = false;

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, true);
        assert.strictEqual(result.snapshotBlocked, false);
        assert.strictEqual(result.snapshot, null);
        assert.strictEqual(harness.retrieveCalls.length, 0);
        assert.strictEqual(harness.inventoryCalls.length, 0);
        assert.deepStrictEqual(result.deploymentExecution, { status: 'Succeeded' });
    });

    await runTest('flag ON captures then deploys only after seal', async () => {
        const harness = createHarness();

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                harness.events.push('deploy');
                return { status: 'Succeeded' };
            }
        });

        assert.deepStrictEqual(harness.events, ['seal', 'deploy']);
        assert.strictEqual(result.snapshot.status, SNAPSHOT_STATUS.SEALED);
        assert.strictEqual(result.snapshotBlocked, false);
        assert.ok(result.snapshot.rollbackEligible);
    });

    await runTest('capture failure blocks deployment', async () => {
        const harness = createHarness({
            retrieveDestinationMember: async () => {
                throw new Error(
                    'Destination snapshot capture failed for ApexClass:AccountService: member retrieval returned no artifact.'
                );
            }
        });
        let deployed = false;

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
                return { status: 'Succeeded' };
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(result.snapshotBlocked, true);
        assert.strictEqual(result.deploymentExecution.status, 'BLOCKED');
        assert.strictEqual(
            result.deploymentExecution.deploymentSummary.deploymentStatus,
            'Blocked'
        );
        assert.match(
            result.deploymentExecution.message,
            /member retrieval returned no artifact/
        );
    });

    await runTest('EXISTS member is MODIFIED with raw destination bytes and SHA-256', async () => {
        const destBytes = Buffer.from('public class AccountService {\r\nold\n}\n', 'utf8');
        const packed = packMemberFiles([
            { relativePath: 'classes/AccountService.cls', bytes: destBytes }
        ]);
        const harness = createHarness({
            retrieveDestinationMember: async () => ({
                artifactBytes: packed
            })
        });

        const capture = await harness.service.captureAndSealForDeploy(BASE_ARGS);
        const members = await harness.captureService.getMembers(
            capture.snapshot.snapshotId
        );
        const [member] = members;

        assert.strictEqual(capture.ok, true);
        assert.strictEqual(member.changeClass, CHANGE_CLASS.MODIFIED);
        assert.strictEqual(member.existedBefore, true);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.COMPLETE);
        assert.strictEqual(member.destinationBeforeHash, hashBytes(packed));
        assert.strictEqual(member.artifactSize, packed.length);
        assert.ok(member.artifactId);

        const stored = await harness.blobStore.getArtifact(member.artifactId);
        assert.ok(stored.equals(packed));
        assert.ok(stored.includes(Buffer.from('\r\n', 'utf8')));
    });

    await runTest('MISSING member is NEW with no artifact and no retrieve', async () => {
        const harness = createHarness({
            buildDestinationInventory: async () =>
                inventoryFor([
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'AccountService',
                        state: DESTINATION_STATE.MISSING
                    }
                ])
        });

        const capture = await harness.service.captureAndSealForDeploy(BASE_ARGS);
        const members = await harness.captureService.getMembers(
            capture.snapshot.snapshotId
        );

        assert.strictEqual(capture.ok, true);
        assert.strictEqual(harness.retrieveCalls.length, 0);
        assert.strictEqual(members[0].changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(members[0].existedBefore, false);
        assert.strictEqual(members[0].artifactId, null);
        assert.strictEqual(capture.snapshot.rollbackEligible, false);
    });

    await runTest('UNKNOWN destination state blocks deployment', async () => {
        const harness = createHarness({
            buildDestinationInventory: async () =>
                inventoryFor([
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'AccountService',
                        state: DESTINATION_STATE.UNKNOWN
                    }
                ])
        });
        let deployed = false;

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(result.snapshotBlocked, true);
        assert.match(
            JSON.stringify(result.deploymentExecution),
            /ApexClass:AccountService/
        );
        assert.match(
            JSON.stringify(result.deploymentExecution),
            /UNKNOWN/
        );
    });

    await runTest('unsupported metadata type blocks deployment when flag ON', async () => {
        const harness = createHarness();
        let deployed = false;

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: {
                ...BASE_ARGS,
                generatedDeploymentPackage: {
                    metadata: [
                        { metadataType: 'Flow', metadataName: 'Onboarding' }
                    ]
                }
            },
            runDeploymentExecution: async () => {
                deployed = true;
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(result.snapshotBlocked, true);
        assert.match(
            JSON.stringify(result.deploymentExecution),
            /Flow:Onboarding/
        );
        assert.match(
            JSON.stringify(result.deploymentExecution),
            /allowlist/
        );
    });

    await runTest('CustomMetadata keeps Weather_Config.Default logical name', async () => {
        const packed = packMemberFiles([
            {
                relativePath: 'customMetadata/Weather_Config.Default.md-meta.xml',
                bytes: Buffer.from('<CustomMetadata>\r\n</CustomMetadata>', 'utf8')
            }
        ]);
        const harness = createHarness({
            retrieveDestinationMember: async (args) => {
                assert.strictEqual(args.metadataType, 'CustomMetadata');
                assert.strictEqual(args.metadataName, 'Weather_Config.Default');
                return { artifactBytes: packed };
            }
        });

        const capture = await harness.service.captureAndSealForDeploy({
            ...BASE_ARGS,
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'CustomMetadata',
                        metadataName: 'Weather_Config.Default'
                    }
                ]
            }
        });
        const members = await harness.captureService.getMembers(
            capture.snapshot.snapshotId
        );

        assert.strictEqual(members[0].metadataName, 'Weather_Config.Default');
        assert.notStrictEqual(members[0].metadataName, 'Weather_Config');
        assert.notStrictEqual(members[0].metadataType, 'CustomMetadataType');
    });

    await runTest('missing destinationOrgId blocks when capture is enabled', async () => {
        const harness = createHarness();
        let deployed = false;

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: true,
            captureArgs: { ...BASE_ARGS, destinationOrgId: null },
            runDeploymentExecution: async () => {
                deployed = true;
            }
        });

        assert.strictEqual(deployed, false);
        assert.match(
            JSON.stringify(result.deploymentExecution),
            /destinationOrgId is required/
        );
    });

    await runTest('VALIDATE-style shouldDeploy false never captures or deploys', async () => {
        const harness = createHarness();
        let deployed = false;

        const result = await harness.service.runDeployAfterOptionalSnapshot({
            shouldDeploy: false,
            captureArgs: BASE_ARGS,
            runDeploymentExecution: async () => {
                deployed = true;
            }
        });

        assert.strictEqual(deployed, false);
        assert.strictEqual(harness.retrieveCalls.length, 0);
        assert.strictEqual(result.deploymentExecution, undefined);
    });
})();
