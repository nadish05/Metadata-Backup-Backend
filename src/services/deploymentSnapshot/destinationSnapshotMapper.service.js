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
    'LightningComponentBundle'
]);

const ALLOWLIST_SET = new Set(SNAPSHOT_CAPTURE_ALLOWLIST);

function isCaptureAllowlisted(metadataType) {
    return ALLOWLIST_SET.has(metadataType);
}

function collectFinalDeploymentMembers(generatedDeploymentPackage) {
    const metadata = Array.isArray(generatedDeploymentPackage?.metadata)
        ? generatedDeploymentPackage.metadata
        : [];
    const seen = new Set();
    const members = [];

    for (const item of metadata) {
        const metadataType = item?.metadataType || item?.type || null;
        const metadataName = item?.metadataName || item?.name || null;

        if (!metadataType || !metadataName) {
            continue;
        }

        const key = `${metadataType}:${metadataName}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        members.push({
            metadataType,
            metadataName,
            filePath: item.filePath || null
        });
    }

    return members;
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
    collectFinalDeploymentMembers,
    mapExistenceToChangeClass,
    buildUnsupportedReason,
    buildUnknownReason,
    buildMissingArtifactReason
};
