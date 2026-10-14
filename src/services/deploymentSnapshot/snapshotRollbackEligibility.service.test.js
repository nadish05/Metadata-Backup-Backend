'use strict';

const assert = require('assert');

const { CHANGE_CLASS, MEMBER_CAPTURE_STATUS } = require('./snapshot.types');
const {
    ROLLBACK_MODE,
    isModifiedRollbackEligibleMember,
    isDeleteRollbackEligibleMember,
    resolveRollbackMode,
    computeRollbackEligible
} = require('./snapshotRollbackEligibility.service');

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

function modifiedMember(name = 'AccountService') {
    return {
        metadataType: 'ApexClass',
        metadataName: name,
        changeClass: CHANGE_CLASS.MODIFIED,
        captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
        destinationBeforeHash: 'before-hash',
        expectedAfterHash: 'after-hash',
        artifactId: `artifact-${name}`
    };
}

function deleteMember(name = 'DemoDeletedClass') {
    return {
        metadataType: 'ApexClass',
        metadataName: name,
        changeClass: CHANGE_CLASS.NEW,
        captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
        existedBefore: false,
        destinationBeforeHash: null,
        artifactId: null,
        expectedAfterHash: 'deployed-hash'
    };
}

(async () => {
    await runTest('MODIFIED-only remains eligible as RESTORE', () => {
        const member = modifiedMember();

        assert.strictEqual(isModifiedRollbackEligibleMember(member), true);
        assert.strictEqual(resolveRollbackMode([member]), ROLLBACK_MODE.RESTORE);
        assert.strictEqual(computeRollbackEligible([member]), true);
    });

    await runTest('DELETE-only remains eligible as DELETE', () => {
        const member = deleteMember();

        assert.strictEqual(isDeleteRollbackEligibleMember(member), true);
        assert.strictEqual(resolveRollbackMode([member]), ROLLBACK_MODE.DELETE);
        assert.strictEqual(computeRollbackEligible([member]), true);
    });

    await runTest('MIXED MODIFIED + NEW/ABSENT_PROVEN resolves to MIXED', () => {
        const members = [modifiedMember(), deleteMember()];

        assert.strictEqual(resolveRollbackMode(members), ROLLBACK_MODE.MIXED);
        assert.strictEqual(computeRollbackEligible(members), true);
    });

    await runTest('MIXED with unsupported member remains ineligible', () => {
        const members = [
            modifiedMember(),
            {
                metadataType: 'ApexClass',
                metadataName: 'UnsupportedClass',
                changeClass: CHANGE_CLASS.NEW,
                captureStatus: MEMBER_CAPTURE_STATUS.UNKNOWN,
                existedBefore: false,
                destinationBeforeHash: null,
                artifactId: null,
                expectedAfterHash: null
            }
        ];

        assert.strictEqual(resolveRollbackMode(members), ROLLBACK_MODE.INELIGIBLE);
        assert.strictEqual(computeRollbackEligible(members), false);
    });
})();
