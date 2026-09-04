'use strict';

const { CHANGE_CLASS, MEMBER_CAPTURE_STATUS } = require('./snapshot.types');

const ROLLBACK_MODE = Object.freeze({
    RESTORE: 'RESTORE',
    DELETE: 'DELETE',
    MIXED: 'MIXED',
    INELIGIBLE: 'INELIGIBLE'
});

function isUsableHash(value) {
    return typeof value === 'string' && value.length > 0;
}

function isModifiedRollbackEligibleMember(member) {
    return (
        member?.changeClass === CHANGE_CLASS.MODIFIED &&
        member.captureStatus === MEMBER_CAPTURE_STATUS.COMPLETE &&
        isUsableHash(member.destinationBeforeHash) &&
        isUsableHash(member.expectedAfterHash) &&
        isUsableHash(member.artifactId)
    );
}

function isDeleteRollbackEligibleMember(member) {
    return (
        member?.changeClass === CHANGE_CLASS.NEW &&
        member.captureStatus === MEMBER_CAPTURE_STATUS.ABSENT_PROVEN &&
        member.existedBefore === false &&
        !member.destinationBeforeHash &&
        !member.artifactId &&
        isUsableHash(member.expectedAfterHash) &&
        isUsableHash(member.metadataType) &&
        isUsableHash(member.metadataName)
    );
}

function resolveRollbackMode(members) {
    if (!Array.isArray(members) || members.length === 0) {
        return ROLLBACK_MODE.INELIGIBLE;
    }

    let hasRestore = false;
    let hasDelete = false;

    for (const member of members) {
        if (isModifiedRollbackEligibleMember(member)) {
            hasRestore = true;
            continue;
        }

        if (isDeleteRollbackEligibleMember(member)) {
            hasDelete = true;
            continue;
        }

        return ROLLBACK_MODE.INELIGIBLE;
    }

    if (hasRestore && hasDelete) {
        return ROLLBACK_MODE.MIXED;
    }

    if (hasRestore) {
        return ROLLBACK_MODE.RESTORE;
    }

    if (hasDelete) {
        return ROLLBACK_MODE.DELETE;
    }

    return ROLLBACK_MODE.INELIGIBLE;
}

function computeRollbackEligible(members) {
    const mode = resolveRollbackMode(members);

    return mode === ROLLBACK_MODE.RESTORE || mode === ROLLBACK_MODE.DELETE;
}

module.exports = {
    ROLLBACK_MODE,
    isModifiedRollbackEligibleMember,
    isDeleteRollbackEligibleMember,
    resolveRollbackMode,
    computeRollbackEligible
};
