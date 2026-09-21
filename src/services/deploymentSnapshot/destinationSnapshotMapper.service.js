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
    'RecordType',
    'BusinessProcess',
    'CompactLayout',
    'StandardValueSet'
]);

const ALLOWLIST_SET = new Set(SNAPSHOT_CAPTURE_ALLOWLIST);

const CUSTOM_OBJECT_CHILD_METADATA_TYPES = Object.freeze(
    new Set([
        'CustomField',
        'ListView',
        'ValidationRule',
        'RecordType'
    ])
);

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

function normalizeDeployedMember(item) {
    const metadataType = item?.metadataType || item?.type || null;
    const metadataName = item?.metadataName || item?.name || null;

    if (!metadataType || !metadataName) {
        return null;
    }

    return {
        metadataType,
        metadataName,
        filePath: item.filePath || null
    };
}

/**
 * Rollback evaluation candidates: every member in the final deployment
 * package metadata[] (actual CLI deploy set). User selectedMetadata is not
 * used for membership; allowlist gating happens at capture time.
 *
 * @param {object|null|undefined} generatedDeploymentPackage
 * @param {Array<object>|null|undefined} [_selectedMetadata] ignored; provenance/UI only
 */
function collectFinalDeploymentMembers(
    generatedDeploymentPackage,
    _selectedMetadata
) {
    const metadata = Array.isArray(generatedDeploymentPackage?.metadata)
        ? generatedDeploymentPackage.metadata
        : [];
    const seen = new Set();
    const members = [];

    for (const item of metadata) {
        const normalized = normalizeDeployedMember(item);

        if (!normalized) {
            continue;
        }

        const key = buildMemberIdentityKey(normalized);

        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        members.push(normalized);
    }

    return members;
}

function resolveCustomObjectChildOwner(metadataType, metadataName) {
    if (!CUSTOM_OBJECT_CHILD_METADATA_TYPES.has(metadataType)) {
        return null;
    }

    const separator = String(metadataName || '').indexOf('.');

    if (separator <= 0) {
        return null;
    }

    return metadataName.slice(0, separator);
}

function memberKey(member) {
    return buildMemberIdentityKey(member);
}

/**
 * When a CustomObject is NEW and every other deployed rollback candidate is a
 * NEW child of that object, snapshot/rollback may use DELETE CustomObject only.
 *
 * @param {Array<object>} members deployed rollback candidates (pre-allowlist or post)
 * @param {Map} inventory destination inventory from buildDestinationInventory
 * @param {Function} inventoryStateFn (inventory, type, name) => state
 */
function collapseRedundantNewCustomObjectChildren(
    members,
    inventory,
    inventoryStateFn
) {
    if (!Array.isArray(members) || members.length === 0) {
        return members;
    }

    const resolveState =
        typeof inventoryStateFn === 'function'
            ? inventoryStateFn
            : () => DESTINATION_STATE.UNKNOWN;

    const changeClassFor = (member) =>
        mapExistenceToChangeClass(
            resolveState(
                inventory,
                member.metadataType,
                member.metadataName
            )
        );

    const memberByKey = new Map(members.map((m) => [memberKey(m), m]));
    const keysToRemove = new Set();

    for (const objectMember of members) {
        if (objectMember.metadataType !== 'CustomObject') {
            continue;
        }

        const objectApiName = objectMember.metadataName;

        if (changeClassFor(objectMember) !== CHANGE_CLASS.NEW) {
            continue;
        }

        const childMembers = members.filter((candidate) => {
            if (candidate.metadataType === 'CustomObject') {
                return false;
            }

            return (
                resolveCustomObjectChildOwner(
                    candidate.metadataType,
                    candidate.metadataName
                ) === objectApiName
            );
        });

        const unrelatedMembers = members.filter((candidate) => {
            const key = memberKey(candidate);

            if (key === memberKey(objectMember)) {
                return false;
            }

            if (
                resolveCustomObjectChildOwner(
                    candidate.metadataType,
                    candidate.metadataName
                ) === objectApiName
            ) {
                return false;
            }

            return true;
        });

        if (unrelatedMembers.length > 0) {
            continue;
        }

        if (!childMembers.length) {
            continue;
        }

        const allChildrenNew = childMembers.every(
            (child) => changeClassFor(child) === CHANGE_CLASS.NEW
        );

        if (!allChildrenNew) {
            continue;
        }

        for (const child of childMembers) {
            keysToRemove.add(memberKey(child));
        }
    }

    if (!keysToRemove.size) {
        return members;
    }

    return members.filter((member) => !keysToRemove.has(memberKey(member)));
}

function buildMissingDeployedMetadataReason() {
    return (
        'Destination snapshot capture failed: final deployment package metadata ' +
        'is required for snapshot capture.'
    );
}

/** @deprecated use buildMissingDeployedMetadataReason */
function buildMissingSelectedMetadataReason() {
    return buildMissingDeployedMetadataReason();
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
    CUSTOM_OBJECT_CHILD_METADATA_TYPES,
    isCaptureAllowlisted,
    buildMemberIdentityKey,
    buildSelectedMemberKeySet,
    collectFinalDeploymentMembers,
    collapseRedundantNewCustomObjectChildren,
    resolveCustomObjectChildOwner,
    mapExistenceToChangeClass,
    buildUnsupportedReason,
    buildUnknownReason,
    buildMissingArtifactReason,
    buildMissingDeployedMetadataReason,
    buildMissingSelectedMetadataReason
};
