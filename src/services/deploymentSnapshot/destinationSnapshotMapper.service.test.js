'use strict';

const assert = require('assert');

const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const { CHANGE_CLASS } = require('./snapshot.types');
const {
    collectFinalDeploymentMembers,
    isCaptureAllowlisted,
    mapExistenceToChangeClass
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

runTest('collects members from generated package metadata only', () => {
    const members = collectFinalDeploymentMembers({
        selectedMetadata: [
            { metadataType: 'ApexClass', metadataName: 'FromSelection' }
        ],
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
    });

    assert.deepStrictEqual(
        members.map((member) => `${member.metadataType}:${member.metadataName}`),
        ['CustomMetadata:Weather_Config.Default', 'ApexClass:AccountService']
    );
    assert.strictEqual(members[0].metadataName, 'Weather_Config.Default');
});

runTest('V1 allowlist includes CustomMetadata and LWC only as listed types', () => {
    assert.strictEqual(isCaptureAllowlisted('ApexClass'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomMetadata'), true);
    assert.strictEqual(isCaptureAllowlisted('LightningComponentBundle'), true);
    assert.strictEqual(isCaptureAllowlisted('Flow'), false);
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
