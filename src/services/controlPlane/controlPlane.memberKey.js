'use strict';

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');

const MEMBER_KEY_SEPARATOR = '|';
const NODE_MEMBER_KEY_SEPARATOR = ':';
const MAX_MEMBER_KEY_LENGTH = 255;

function assertNoSeparator(value, fieldName) {
    const text = String(value == null ? '' : value);

    if (!text) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `${fieldName} is required for member-key translation.`
        );
    }

    if (text.includes(MEMBER_KEY_SEPARATOR)) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `${fieldName} contains "|" and cannot be translated collision-safely.`
        );
    }

    return text;
}

function toSalesforceMemberKey(snapshotId, metadataType, metadataName) {
    const snap = assertNoSeparator(snapshotId, 'snapshotId');
    const type = assertNoSeparator(metadataType, 'metadataType');
    const name = assertNoSeparator(metadataName, 'metadataName');
    const key = `${snap}${MEMBER_KEY_SEPARATOR}${type}${MEMBER_KEY_SEPARATOR}${name}`;

    if (key.length > MAX_MEMBER_KEY_LENGTH) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `Salesforce Member_Key__c would exceed ${MAX_MEMBER_KEY_LENGTH} characters and is not collision-safe to truncate.`
        );
    }

    return key;
}

function fromSalesforceMemberKey(memberKey) {
    const text = String(memberKey == null ? '' : memberKey);

    if (!text) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'Salesforce Member_Key__c is required.'
        );
    }

    const parts = text.split(MEMBER_KEY_SEPARATOR);

    if (parts.length !== 3 || parts.some((part) => !part)) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'Salesforce Member_Key__c is not snapshotId|type|name.'
        );
    }

    return {
        snapshotId: parts[0],
        metadataType: parts[1],
        metadataName: parts[2],
        nodeKey: `${parts[1]}${NODE_MEMBER_KEY_SEPARATOR}${parts[2]}`
    };
}

function isMemberKeyTranslationCollisionSafe(snapshotId, metadataType, metadataName) {
    try {
        const salesforceKey = toSalesforceMemberKey(
            snapshotId,
            metadataType,
            metadataName
        );
        const reversed = fromSalesforceMemberKey(salesforceKey);

        return (
            reversed.snapshotId === String(snapshotId) &&
            reversed.metadataType === String(metadataType) &&
            reversed.metadataName === String(metadataName) &&
            reversed.nodeKey === `${metadataType}${NODE_MEMBER_KEY_SEPARATOR}${metadataName}`
        );
    } catch (error) {
        return false;
    }
}

module.exports = {
    MEMBER_KEY_SEPARATOR,
    MAX_MEMBER_KEY_LENGTH,
    fromSalesforceMemberKey,
    isMemberKeyTranslationCollisionSafe,
    toSalesforceMemberKey
};
