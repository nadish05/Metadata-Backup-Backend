'use strict';

const assert = require('assert');

const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const { CHANGE_CLASS } = require('./snapshot.types');
const {
    collectFinalDeploymentMembers,
    isCaptureAllowlisted,
    mapExistenceToChangeClass,
    buildMemberIdentityKey
} = require('./destinationSnapshotMapper.service');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

const FULL_PACKAGE = {
    metadata: [
        {
            metadataType: 'RecordType',
            metadataName: 'Opportunity.Enterprise_Deal',
            filePath:
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml'
        },
        {
            metadataType: 'BusinessProcess',
            metadataName: 'Opportunity.New Sales Process',
            filePath:
                'force-app/main/default/objects/Opportunity/businessProcesses/New Sales Process.businessProcess-meta.xml'
        },
        {
            metadataType: 'CustomField',
            metadataName: 'Opportunity.Approval_Status__c',
            filePath:
                'force-app/main/default/objects/Opportunity/fields/Approval_Status__c.field-meta.xml'
        },
        {
            metadataType: 'StandardValueSet',
            metadataName: 'LeadSource',
            filePath:
                'force-app/main/default/standardValueSets/LeadSource.standardValueSet-meta.xml'
        }
    ]
};

runTest(
    'collects only selected members intersected with package metadata',
    () => {
        const members = collectFinalDeploymentMembers(
            {
                metadata: [
                    {
                        metadataType: 'CustomMetadata',
                        metadataName: 'Weather_Config.Default',
                        filePath: 'customMetadata/Weather_Config.Default.md-meta.xml'
                    },
                    {
                        type: 'ApexClass',
                        name: 'AccountService',
                        filePath: 'classes/AccountService.cls'
                    }
                ]
            },
            [{ metadataType: 'ApexClass', metadataName: 'AccountService' }]
        );

        assert.deepStrictEqual(
            members.map((member) => `${member.metadataType}:${member.metadataName}`),
            ['ApexClass:AccountService']
        );
        assert.strictEqual(members[0].filePath, 'classes/AccountService.cls');
    }
);

runTest('TEST 1: dependency excluded when not selected', () => {
    const members = collectFinalDeploymentMembers(FULL_PACKAGE, [
        { metadataType: 'RecordType', metadataName: 'Opportunity.Enterprise_Deal' }
    ]);

    assert.deepStrictEqual(
        members.map((m) => `${m.metadataType}:${m.metadataName}`),
        ['RecordType:Opportunity.Enterprise_Deal']
    );
});

runTest('TEST 2: explicit CustomField selected is included', () => {
    const members = collectFinalDeploymentMembers(FULL_PACKAGE, [
        { metadataType: 'RecordType', metadataName: 'Opportunity.Enterprise_Deal' },
        {
            metadataType: 'CustomField',
            metadataName: 'Opportunity.Approval_Status__c'
        }
    ]);

    assert.deepStrictEqual(
        members.map((m) => `${m.metadataType}:${m.metadataName}`).sort(),
        [
            'CustomField:Opportunity.Approval_Status__c',
            'RecordType:Opportunity.Enterprise_Deal'
        ].sort()
    );
});

runTest('TEST 3: BusinessProcess never auto-captured', () => {
    const members = collectFinalDeploymentMembers(
        {
            metadata: [
                FULL_PACKAGE.metadata[0],
                FULL_PACKAGE.metadata[1]
            ]
        },
        [{ metadataType: 'RecordType', metadataName: 'Opportunity.Enterprise_Deal' }]
    );

    assert.ok(
        !members.some((m) => m.metadataType === 'BusinessProcess')
    );
});

runTest('TEST 4: StandardValueSet dependency excluded', () => {
    const members = collectFinalDeploymentMembers(FULL_PACKAGE, [
        { metadataType: 'RecordType', metadataName: 'Opportunity.Enterprise_Deal' }
    ]);

    assert.ok(!members.some((m) => m.metadataType === 'StandardValueSet'));
});

runTest('TEST 5: type + name match is exact', () => {
    const members = collectFinalDeploymentMembers(
        {
            metadata: [
                {
                    metadataType: 'RecordType',
                    metadataName: 'Opportunity.Enterprise_Deal',
                    filePath: 'a'
                },
                {
                    metadataType: 'RecordType',
                    metadataName: 'Account.Enterprise_Deal',
                    filePath: 'b'
                }
            ]
        },
        [{ metadataType: 'RecordType', metadataName: 'Opportunity.Enterprise_Deal' }]
    );

    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].metadataName, 'Opportunity.Enterprise_Deal');
});

runTest('TEST 6: missing selectedMetadata yields no members', () => {
    assert.deepStrictEqual(
        collectFinalDeploymentMembers(FULL_PACKAGE, undefined),
        []
    );
    assert.deepStrictEqual(collectFinalDeploymentMembers(FULL_PACKAGE, null), []);
    assert.deepStrictEqual(
        collectFinalDeploymentMembers(FULL_PACKAGE, []),
        []
    );
});

runTest('V1 allowlist includes ValidationRule alongside proven snapshot types', () => {
    assert.strictEqual(isCaptureAllowlisted('ApexClass'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomObject'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomField'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomMetadata'), true);
    assert.strictEqual(isCaptureAllowlisted('LightningComponentBundle'), true);
    assert.strictEqual(isCaptureAllowlisted('ListView'), true);
    assert.strictEqual(isCaptureAllowlisted('ValidationRule'), true);
    assert.strictEqual(isCaptureAllowlisted('RecordType'), true);
    assert.strictEqual(isCaptureAllowlisted('Flow'), false);
    assert.strictEqual(isCaptureAllowlisted('BusinessProcess'), false);
    assert.strictEqual(isCaptureAllowlisted('StandardValueSet'), false);
    assert.strictEqual(isCaptureAllowlisted('CustomMetadataType'), false);
});

runTest('maps destination existence without Git changeType', () => {
    assert.strictEqual(
        mapExistenceToChangeClass(DESTINATION_STATE.EXISTS),
        CHANGE_CLASS.MODIFIED
    );
    assert.strictEqual(
        mapExistenceToChangeClass(DESTINATION_STATE.MISSING),
        CHANGE_CLASS.NEW
    );
    assert.strictEqual(
        mapExistenceToChangeClass(DESTINATION_STATE.UNKNOWN),
        CHANGE_CLASS.UNKNOWN
    );
});

runTest('buildMemberIdentityKey uses metadataType and metadataName', () => {
    assert.strictEqual(
        buildMemberIdentityKey({
            metadataType: 'RecordType',
            metadataName: 'Opportunity.Enterprise_Deal'
        }),
        'RecordType:Opportunity.Enterprise_Deal'
    );
});
