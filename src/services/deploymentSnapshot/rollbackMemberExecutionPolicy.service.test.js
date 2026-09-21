'use strict';

const assert = require('assert');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./snapshot.types');
const {
    REASON_CODE,
    isManualRecordTypeDelete,
    partitionRollbackExecutionMembers
} = require('./rollbackMemberExecutionPolicy.service');

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

function deleteEligibleMember(overrides = {}) {
    return {
        metadataType: 'ApexClass',
        metadataName: 'DemoClass',
        changeClass: CHANGE_CLASS.NEW,
        captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
        existedBefore: false,
        destinationBeforeHash: null,
        artifactId: null,
        expectedAfterHash: 'abc',
        ...overrides
    };
}

runTest('RecordType NEW delete-eligible is manual', () => {
    const member = deleteEligibleMember({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal'
    });

    assert.strictEqual(isManualRecordTypeDelete(member), true);
});

runTest('RecordType MODIFIED is not manual', () => {
    const member = {
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal',
        changeClass: CHANGE_CLASS.MODIFIED,
        captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
        destinationBeforeHash: 'a',
        expectedAfterHash: 'b',
        artifactId: 'artifact-1'
    };

    assert.strictEqual(isManualRecordTypeDelete(member), false);
});

runTest('BusinessProcess linked to manual RecordType is manual', () => {
    const recordType = deleteEligibleMember({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal'
    });
    const businessProcess = deleteEligibleMember({
        metadataType: 'BusinessProcess',
        metadataName: 'Opportunity.New Sales Process'
    });
    const map = new Map([
        ['RecordType:Opportunity.Enterprise_Deal', 'New Sales Process']
    ]);
    const partition = partitionRollbackExecutionMembers(
        [recordType, businessProcess],
        { recordTypeBusinessProcessByMemberKey: map }
    );

    assert.strictEqual(partition.automaticMembers.length, 0);
    assert.strictEqual(partition.manualRollbackItems.length, 2);
    assert.strictEqual(
        partition.manualRollbackItems[1].reasonCode,
        REASON_CODE.ASSOCIATED_WITH_UNSUPPORTED_RECORDTYPE
    );
});

runTest('BusinessProcess without proven link stays automatic', () => {
    const recordType = deleteEligibleMember({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal'
    });
    const businessProcess = deleteEligibleMember({
        metadataType: 'BusinessProcess',
        metadataName: 'Opportunity.Other Process'
    });
    const map = new Map([
        ['RecordType:Opportunity.Enterprise_Deal', 'New Sales Process']
    ]);
    const partition = partitionRollbackExecutionMembers(
        [recordType, businessProcess],
        { recordTypeBusinessProcessByMemberKey: map }
    );

    assert.strictEqual(partition.automaticMembers.length, 1);
    assert.strictEqual(
        partition.automaticMembers[0].metadataName,
        'Opportunity.Other Process'
    );
    assert.strictEqual(partition.manualRollbackItems.length, 1);
});

runTest('mixed partition keeps supported members automatic', () => {
    const recordType = deleteEligibleMember({
        metadataType: 'RecordType',
        metadataName: 'Opportunity.Enterprise_Deal'
    });
    const validationRule = {
        metadataType: 'ValidationRule',
        metadataName: 'Opportunity.Amount_must_be_greater_than_0',
        changeClass: CHANGE_CLASS.MODIFIED,
        captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
        destinationBeforeHash: 'a',
        expectedAfterHash: 'b',
        artifactId: 'artifact-vr'
    };
    const apexClass = deleteEligibleMember({
        metadataType: 'ApexClass',
        metadataName: 'SomeClass'
    });
    const map = new Map([
        ['RecordType:Opportunity.Enterprise_Deal', 'New Sales Process']
    ]);
    const partition = partitionRollbackExecutionMembers(
        [recordType, validationRule, apexClass],
        { recordTypeBusinessProcessByMemberKey: map }
    );

    assert.strictEqual(partition.manualRollbackItems.length, 1);
    assert.strictEqual(partition.automaticMembers.length, 2);
    assert.deepStrictEqual(
        partition.automaticMembers.map((member) => member.metadataType).sort(),
        ['ApexClass', 'ValidationRule']
    );
});
