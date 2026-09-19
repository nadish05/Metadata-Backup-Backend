'use strict';

const { CHANGE_CLASS } = require('./snapshot.types');
const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');

const SNAPSHOT_CAPTURE_ALLOWLIST = Object.freeze([
    'ApexClass',
    'ApexTrigger',
    'CustomObject',
    'CustomField',
    'CustomMetadata',
    'LightningComponentBundle',
    'ListView',
    'ValidationRule',
    'RecordType'
]);

const ALLOWLIST_SET = new Set(SNAPSHOT_CAPTURE_ALLOWLIST);

function isCaptureAllowlisted(metadataType) {
    return ALLOWLIST_SET.has(metadataType);
}

function buildMemberIdentityKey(item) {
    const metadataType = item?.metadataType || item?.type || null;
    const metadataName = item?.metadataName || item?.name || null;

    if (!metadataType || !metadataName) {
        return null;
    }

    return `${metadataType}:${metadataName}`;
}

function buildSelectedMemberKeySet(selectedMetadata) {
    const keys = new Set();

    if (!Array.isArray(selectedMetadata)) {
        return keys;
    }

    for (const item of selectedMetadata) {
        const key = buildMemberIdentityKey(item);

        if (key) {
            keys.add(key);
        }
    }

    return keys;
}

/**
 * Snapshot rollback candidates: selected primary metadata intersected with
 * final package metadata (for filePath). Dependencies in metadata[] alone
 * are not captured unless also present in selectedMetadata.
 */
function collectFinalDeploymentMembers(
    generatedDeploymentPackage,
    selectedMetadata
) {
    const metadata = Array.isArray(generatedDeploymentPackage?.metadata)
        ? generatedDeploymentPackage.metadata
        : [];
    const selectedKeys = buildSelectedMemberKeySet(selectedMetadata);
    const seen = new Set();
    const members = [];

    for (const item of metadata) {
        const key = buildMemberIdentityKey(item);

        if (!key || !selectedKeys.has(key)) {
            continue;
        }

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        members.push({
            metadataType: item.metadataType || item.type,
            metadataName: item.metadataName || item.name,
            filePath: item.filePath || null
        });
    }

    return members;
}

function buildMissingSelectedMetadataReason() {
    return (
        'Destination snapshot capture failed: selected metadata is required ' +
        'for snapshot capture.'
    );
}

function mapExistenceToChangeClass(existenceState) {
    if (existenceState === DESTINATION_STATE.EXISTS) {
        return CHANGE_CLASS.MODIFIED;
    }

    if (existenceState === DESTINATION_STATE.MISSING) {
        return CHANGE_CLASS.NEW;
    }

    return CHANGE_CLASS.UNKNOWN;
}

function buildUnsupportedReason(metadataType, metadataName) {
    return (
        `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
        'metadata type is not in the V1 snapshot allowlist.'
    );
}

function buildUnknownReason(metadataType, metadataName, detail) {
    return (
        `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
        (detail || 'destination state is UNKNOWN.')
    );
}

function buildMissingArtifactReason(metadataType, metadataName) {
    return (
        `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
        'member retrieval returned no artifact.'
    );
}

module.exports = {
    SNAPSHOT_CAPTURE_ALLOWLIST,
    isCaptureAllowlisted,
    buildMemberIdentityKey,
    buildSelectedMemberKeySet,
    collectFinalDeploymentMembers,
    mapExistenceToChangeClass,
    buildUnsupportedReason,
    buildUnknownReason,
    buildMissingArtifactReason,
    buildMissingSelectedMetadataReason
};
