'use strict';

const { CHANGE_CLASS } = require('./snapshot.types');
const {
    isDeleteRollbackEligibleMember
} = require('./snapshotRollbackEligibility.service');
const {
    parseRecordTypeIdentity
} = require('./recordTypeSemanticExpectedAfter.service');

const REASON_CODE = Object.freeze({
    RECORDTYPE_DELETE_UNSUPPORTED: 'RECORDTYPE_DELETE_UNSUPPORTED',
    ASSOCIATED_WITH_UNSUPPORTED_RECORDTYPE:
        'ASSOCIATED_WITH_UNSUPPORTED_RECORDTYPE'
});

const RECORD_TYPE_MANUAL_REASON =
    'RecordType metadata cannot be deleted through the Salesforce Metadata API.';
const BUSINESS_PROCESS_MANUAL_REASON =
    'This Sales Process is associated with a RecordType that requires manual rollback.';

function memberKey(member) {
    return `${member.metadataType}:${member.metadataName}`;
}

function isManualRecordTypeDelete(member) {
    return (
        member?.metadataType === 'RecordType' &&
        member?.changeClass === CHANGE_CLASS.NEW &&
        isDeleteRollbackEligibleMember(member)
    );
}

function parseBusinessProcessMetadataName(metadataName) {
    const value = String(metadataName || '').trim();
    const separator = value.indexOf('.');

    if (separator <= 0 || separator === value.length - 1) {
        return null;
    }

    return {
        objectApiName: value.slice(0, separator).trim(),
        processName: value.slice(separator + 1).trim()
    };
}

function isBusinessProcessAssociatedWithManualRecordType(
    member,
    manualRecordTypeMembers,
    recordTypeBusinessProcessByMemberKey
) {
    if (
        member?.metadataType !== 'BusinessProcess' ||
        !isDeleteRollbackEligibleMember(member)
    ) {
        return false;
    }

    const businessProcessIdentity = parseBusinessProcessMetadataName(
        member.metadataName
    );

    if (!businessProcessIdentity?.objectApiName || !businessProcessIdentity.processName) {
        return false;
    }

    for (const recordTypeMember of manualRecordTypeMembers) {
        const linkedProcess = recordTypeBusinessProcessByMemberKey.get(
            memberKey(recordTypeMember)
        );

        if (!linkedProcess) {
            continue;
        }

        try {
            const recordTypeIdentity = parseRecordTypeIdentity(
                recordTypeMember.metadataName
            );

            if (
                recordTypeIdentity.objectApiName ===
                    businessProcessIdentity.objectApiName &&
                linkedProcess === businessProcessIdentity.processName
            ) {
                return true;
            }
        } catch (error) {
            void error;
        }
    }

    return false;
}

function partitionRollbackExecutionMembers(members, options = {}) {
    const recordTypeBusinessProcessByMemberKey =
        options.recordTypeBusinessProcessByMemberKey || new Map();
    const inputMembers = Array.isArray(members) ? members : [];

    const manualRecordTypeMembers = [];
    const manualKeySet = new Set();
    const manualRollbackItems = [];

    for (const member of inputMembers) {
        if (!isManualRecordTypeDelete(member)) {
            continue;
        }

        manualKeySet.add(memberKey(member));
        manualRecordTypeMembers.push(member);
        manualRollbackItems.push({
            metadataType: member.metadataType,
            metadataName: member.metadataName,
            reasonCode: REASON_CODE.RECORDTYPE_DELETE_UNSUPPORTED,
            reason: RECORD_TYPE_MANUAL_REASON
        });
    }

    const automaticMembers = [];

    for (const member of inputMembers) {
        const key = memberKey(member);

        if (manualKeySet.has(key)) {
            continue;
        }

        if (
            isBusinessProcessAssociatedWithManualRecordType(
                member,
                manualRecordTypeMembers,
                recordTypeBusinessProcessByMemberKey
            )
        ) {
            manualKeySet.add(key);
            manualRollbackItems.push({
                metadataType: member.metadataType,
                metadataName: member.metadataName,
                reasonCode: REASON_CODE.ASSOCIATED_WITH_UNSUPPORTED_RECORDTYPE,
                reason: BUSINESS_PROCESS_MANUAL_REASON
            });
            continue;
        }

        automaticMembers.push(member);
    }

    return {
        automaticMembers,
        manualRollbackItems
    };
}

module.exports = {
    REASON_CODE,
    isManualRecordTypeDelete,
    partitionRollbackExecutionMembers
};
