'use strict';

const assert = require('assert');

const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    SNAPSHOT_STATUS,
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    EXPECTED_AFTER_REPRESENTATION
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
    const expectedAfterCalls = [];
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
            }),
        collectExpectedAfterArtifact:
            overrides.collectExpectedAfterArtifact ||
            (async (args) => {
                expectedAfterCalls.push(args);
                const bytes = packMemberFiles([
                    {
                        relativePath: 'classes/AccountService.cls',
                        bytes: Buffer.from('destination-after\n', 'utf8')
                    }
                ]);
                return {
                    artifactBytes: bytes,
                    expectedAfterHash: hashBytes(bytes)
                };
            })
    });

    return {
        service,
        events,
        retrieveCalls,
        expectedAfterCalls,
        inventoryCalls,
        blobStore,
        captureService
    };
}

const VALIDATION_RULE_PATH =
    'force-app/main/default/objects/Vehicle__c/validationRules/Require_Model.validationRule-meta.xml';

const RECORD_TYPE_PATH =
    'force-app/main/default/objects/Vehicle__c/recordTypes/Some_Record_Type.recordType-meta.xml';

const RECORD_TYPE_CAPTURE_ARGS = {
    destinationOrgId: '00D000000000001',
    sourceOrgId: '00D000000000002',
    historyId: 'hist-record-type',
    sourceBranch: 'feature',
    destinationBranch: 'main',
    refreshToken: 'refresh-secret',
    instanceUrl: 'https://dest.example.com',
    selectedMetadata: [
        {
            metadataType: 'RecordType',
            metadataName: 'Vehicle__c.Some_Record_Type'
        }
    ],
    generatedDeploymentPackage: {
        metadata: [
            {
                metadataType: 'RecordType',
                metadataName: 'Vehicle__c.Some_Record_Type',
                filePath: RECORD_TYPE_PATH
            }
        ]
    }
};

const VALIDATION_RULE_CAPTURE_ARGS = {
    destinationOrgId: '00D000000000001',
    sourceOrgId: '00D000000000002',
    historyId: 'hist-validation-rule',
    sourceBranch: 'feature',
    destinationBranch: 'main',
    refreshToken: 'refresh-secret',
    instanceUrl: 'https://dest.example.com',
    selectedMetadata: [
        {
            metadataType: 'ValidationRule',
            metadataName: 'Vehicle__c.Require_Model'
        }
    ],
    generatedDeploymentPackage: {
        metadata: [
            {
                metadataType: 'ValidationRule',
                metadataName: 'Vehicle__c.Require_Model',
                filePath: VALIDATION_RULE_PATH
            }
        ]
    }
};

const BASE_ARGS = {
    destinationOrgId: '00D000000000001',
    sourceOrgId: '00D000000000002',
    historyId: 'hist-1',
    sourceBranch: 'feature',
    destinationBranch: 'main',
    refreshToken: 'refresh-secret',
    instanceUrl: 'https://dest.example.com',
    selectedMetadata: [
        { metadataType: 'ApexClass', metadataName: 'AccountService' }
    ],
    generatedDeploymentPackage: {
        metadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: 'classes/AccountService.cls'
            }
        ]
    }
};

const OPPORTUNITY_RECORD_TYPE_PATH =
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml';

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
        assert.strictEqual(harness.expectedAfterCalls.length, 0);
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
        assert.ok(member.expectedAfterHash);
        assert.notStrictEqual(member.expectedAfterHash, member.destinationBeforeHash);
        assert.strictEqual(member.artifactSize, packed.length);
        assert.ok(member.artifactId);

        const stored = await harness.blobStore.getArtifact(member.artifactId);
        assert.ok(stored.equals(packed));
        assert.ok(stored.includes(Buffer.from('\r\n', 'utf8')));
    });

    await runTest('MISSING member is NEW with expected-after hash and no retrieve', async () => {
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
        assert.strictEqual(harness.expectedAfterCalls.length, 1);
        assert.strictEqual(members[0].changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(members[0].existedBefore, false);
        assert.strictEqual(members[0].artifactId, null);
        assert.ok(members[0].expectedAfterHash);
        assert.strictEqual(members[0].destinationBeforeHash, null);
        assert.strictEqual(capture.snapshot.rollbackEligible, true);
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
                selectedMetadata: [
                    { metadataType: 'Flow', metadataName: 'Onboarding' }
                ],
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
            selectedMetadata: [
                {
                    metadataType: 'CustomMetadata',
                    metadataName: 'Weather_Config.Default'
                }
            ],
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

    await runTest('ValidationRule EXISTS capture is MODIFIED with RAW representation', async () => {
        const destRuleXml = Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active></ValidationRule>',
            'utf8'
        );
        const destPacked = packMemberFiles([
            { relativePath: VALIDATION_RULE_PATH, bytes: destRuleXml }
        ]);
        const afterRuleXml = Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><errorMessage>Model required</errorMessage></ValidationRule>',
            'utf8'
        );
        const afterPacked = packMemberFiles([
            { relativePath: VALIDATION_RULE_PATH, bytes: afterRuleXml }
        ]);
        const harness = createHarness({
            retrieveDestinationMember: async () => ({
                artifactBytes: destPacked
            }),
            collectExpectedAfterArtifact: async () => ({
                artifactBytes: afterPacked,
                expectedAfterHash: hashBytes(afterPacked),
                expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW
            })
        });

        const capture = await harness.service.captureAndSealForDeploy(
            VALIDATION_RULE_CAPTURE_ARGS
        );
        const members = await harness.captureService.getMembers(
            capture.snapshot.snapshotId
        );
        const [member] = members;

        assert.strictEqual(capture.ok, true);
        assert.strictEqual(member.changeClass, CHANGE_CLASS.MODIFIED);
        assert.strictEqual(member.existedBefore, true);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.COMPLETE);
        assert.strictEqual(member.destinationBeforeHash, hashBytes(destPacked));
        assert.ok(member.expectedAfterHash);
        assert.strictEqual(
            member.expectedAfterRepresentation,
            EXPECTED_AFTER_REPRESENTATION.RAW
        );
        assert.ok(member.artifactId);
    });

    await runTest('ValidationRule MISSING capture is NEW with ABSENT_PROVEN', async () => {
        const afterPacked = packMemberFiles([
            {
                relativePath: VALIDATION_RULE_PATH,
                bytes: Buffer.from('<ValidationRule/>', 'utf8')
            }
        ]);
        const harness = createHarness({
            buildDestinationInventory: async () =>
                inventoryFor([
                    {
                        metadataType: 'ValidationRule',
                        metadataName: 'Vehicle__c.Require_Model',
                        state: DESTINATION_STATE.MISSING
                    }
                ]),
            collectExpectedAfterArtifact: async () => ({
                artifactBytes: afterPacked,
                expectedAfterHash: hashBytes(afterPacked),
                expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW
            })
        });

        const capture = await harness.service.captureAndSealForDeploy(
            VALIDATION_RULE_CAPTURE_ARGS
        );
        const members = await harness.captureService.getMembers(
            capture.snapshot.snapshotId
        );
        const [member] = members;

        assert.strictEqual(capture.ok, true);
        assert.strictEqual(harness.retrieveCalls.length, 0);
        assert.strictEqual(member.changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(member.existedBefore, false);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
        assert.strictEqual(member.destinationBeforeHash, null);
        assert.ok(member.expectedAfterHash);
        assert.strictEqual(
            member.expectedAfterRepresentation,
            EXPECTED_AFTER_REPRESENTATION.RAW
        );
        assert.strictEqual(member.artifactId, null);
    });

    await runTest('RecordType EXISTS capture is MODIFIED with RAW representation', async () => {
        const destRecordTypeXml = Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><RecordType xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active></RecordType>',
            'utf8'
        );
        const destPacked = packMemberFiles([
            { relativePath: RECORD_TYPE_PATH, bytes: destRecordTypeXml }
        ]);
        const afterRecordTypeXml = Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><RecordType xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><label>Some Record Type</label></RecordType>',
            'utf8'
        );
        const afterPacked = packMemberFiles([
            { relativePath: RECORD_TYPE_PATH, bytes: afterRecordTypeXml }
        ]);
        const harness = createHarness({
            retrieveDestinationMember: async () => ({
                artifactBytes: destPacked
            }),
            collectExpectedAfterArtifact: async () => ({
                artifactBytes: afterPacked,
                expectedAfterHash: hashBytes(afterPacked),
                expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW
            })
        });

        const capture = await harness.service.captureAndSealForDeploy(
            RECORD_TYPE_CAPTURE_ARGS
        );
        const members = await harness.captureService.getMembers(
            capture.snapshot.snapshotId
        );
        const [member] = members;

        assert.strictEqual(capture.ok, true);
        assert.strictEqual(member.metadataType, 'RecordType');
        assert.strictEqual(member.metadataName, 'Vehicle__c.Some_Record_Type');
        assert.strictEqual(member.changeClass, CHANGE_CLASS.MODIFIED);
        assert.strictEqual(member.existedBefore, true);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.COMPLETE);
        assert.strictEqual(member.destinationBeforeHash, hashBytes(destPacked));
        assert.ok(member.expectedAfterHash);
        assert.strictEqual(
            member.expectedAfterRepresentation,
            EXPECTED_AFTER_REPRESENTATION.RAW
        );
        assert.ok(member.artifactId);
    });

    await runTest('RecordType MISSING capture is NEW with ABSENT_PROVEN', async () => {
        const afterPacked = packMemberFiles([
            {
                relativePath: RECORD_TYPE_PATH,
                bytes: Buffer.from('<RecordType/>', 'utf8')
            }
        ]);
        const harness = createHarness({
            buildDestinationInventory: async () =>
                inventoryFor([
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Vehicle__c.Some_Record_Type',
                        state: DESTINATION_STATE.MISSING
                    }
                ]),
            collectExpectedAfterArtifact: async () => ({
                artifactBytes: afterPacked,
                expectedAfterHash: hashBytes(afterPacked),
                expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW
            })
        });

        const capture = await harness.service.captureAndSealForDeploy(
            RECORD_TYPE_CAPTURE_ARGS
        );
        const members = await harness.captureService.getMembers(
            capture.snapshot.snapshotId
        );
        const [member] = members;

        assert.strictEqual(capture.ok, true);
        assert.strictEqual(harness.retrieveCalls.length, 0);
        assert.strictEqual(member.changeClass, CHANGE_CLASS.NEW);
        assert.strictEqual(member.existedBefore, false);
        assert.strictEqual(member.captureStatus, MEMBER_CAPTURE_STATUS.ABSENT_PROVEN);
        assert.strictEqual(member.destinationBeforeHash, null);
        assert.ok(member.expectedAfterHash);
        assert.strictEqual(
            member.expectedAfterRepresentation,
            EXPECTED_AFTER_REPRESENTATION.RAW
        );
        assert.strictEqual(member.artifactId, null);
    });

    await runTest('RecordType UNKNOWN destination state blocks capture', async () => {
        const harness = createHarness({
            buildDestinationInventory: async () =>
                inventoryFor([
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Vehicle__c.Some_Record_Type',
                        state: DESTINATION_STATE.UNKNOWN
                    }
                ])
        });

        const capture = await harness.service.captureAndSealForDeploy(
            RECORD_TYPE_CAPTURE_ARGS
        );

        assert.strictEqual(capture.ok, false);
        assert.match(capture.message, /RecordType:Vehicle__c.Some_Record_Type/);
        assert.match(capture.message, /UNKNOWN/);
    });

    await runTest('ValidationRule UNKNOWN destination state blocks capture', async () => {
        const harness = createHarness({
            buildDestinationInventory: async () =>
                inventoryFor([
                    {
                        metadataType: 'ValidationRule',
                        metadataName: 'Vehicle__c.Require_Model',
                        state: DESTINATION_STATE.UNKNOWN
                    }
                ])
        });

        const capture = await harness.service.captureAndSealForDeploy(
            VALIDATION_RULE_CAPTURE_ARGS
        );

        assert.strictEqual(capture.ok, false);
        assert.match(capture.message, /ValidationRule:Vehicle__c.Require_Model/);
        assert.match(capture.message, /UNKNOWN/);
    });

    await runTest('missing expected-after workspace artifact blocks deploy', async () => {
        const harness = createHarness({
            collectExpectedAfterArtifact: async () => {
                throw new Error(
                    'Destination snapshot capture failed for ApexClass:AccountService: expected-after workspace artifact is missing.'
                );
            }
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
            result.deploymentExecution.message,
            /expected-after workspace artifact is missing/
        );
    });

    await runTest(
        'missing selectedMetadata fails closed without capturing package dependencies',
        async () => {
            const harness = createHarness();
            const capture = await harness.service.captureAndSealForDeploy({
                ...BASE_ARGS,
                selectedMetadata: undefined
            });

            assert.strictEqual(capture.ok, false);
            assert.match(capture.message, /selected metadata is required/);
            assert.strictEqual(harness.events.length, 0);
        }
    );

    await runTest(
        'TEST 11: RecordType selected with dependency-only package members succeeds',
        async () => {
            const afterPacked = packMemberFiles([
                {
                    relativePath: OPPORTUNITY_RECORD_TYPE_PATH,
                    bytes: Buffer.from('<RecordType/>', 'utf8')
                }
            ]);
            const harness = createHarness({
                buildDestinationInventory: async () =>
                    inventoryFor([
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Opportunity.Enterprise_Deal',
                            state: DESTINATION_STATE.MISSING
                        }
                    ]),
                collectExpectedAfterArtifact: async () => ({
                    artifactBytes: afterPacked,
                    expectedAfterHash: hashBytes(afterPacked),
                    expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW
                })
            });

            const capture = await harness.service.captureAndSealForDeploy({
                destinationOrgId: BASE_ARGS.destinationOrgId,
                sourceOrgId: BASE_ARGS.sourceOrgId,
                historyId: 'hist-enterprise-deal',
                refreshToken: BASE_ARGS.refreshToken,
                instanceUrl: BASE_ARGS.instanceUrl,
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Opportunity.Enterprise_Deal',
                            filePath: OPPORTUNITY_RECORD_TYPE_PATH
                        },
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Opportunity.Approval_Status__c',
                            filePath:
                                'force-app/main/default/objects/Opportunity/fields/Approval_Status__c.field-meta.xml'
                        },
                        {
                            metadataType: 'BusinessProcess',
                            metadataName: 'Opportunity.New Sales Process',
                            filePath:
                                'force-app/main/default/objects/Opportunity/businessProcesses/New Sales Process.businessProcess-meta.xml'
                        }
                    ]
                }
            });

            assert.strictEqual(capture.ok, true);
            const members = await harness.captureService.getMembers(
                capture.snapshot.snapshotId
            );
            assert.strictEqual(members.length, 1);
            assert.strictEqual(members[0].metadataType, 'RecordType');
            assert.strictEqual(
                members[0].metadataName,
                'Opportunity.Enterprise_Deal'
            );
            assert.strictEqual(
                members[0].captureStatus,
                MEMBER_CAPTURE_STATUS.ABSENT_PROVEN
            );
            assert.ok(
                !members.some((m) => m.metadataType === 'BusinessProcess')
            );
            assert.ok(
                !members.some((m) => m.metadataType === 'CustomField')
            );
        }
    );
})();
