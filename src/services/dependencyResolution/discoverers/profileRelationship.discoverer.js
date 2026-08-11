/**
 * Profile Relationship Discoverer (Phase 19.2 / 19.3 / 19.4 / 19.5)
 *
 * Profile-specific. Currently discovers:
 *   objectPermissions      → CustomObject (custom __c names)
 *   fieldPermissions       → CustomObject + CustomField (Object__c.Field__c)
 *   recordTypeVisibilities → RecordType (Obj.Rt; standard + custom objects)
 *   tabVisibilities        → CustomTab (custom tab names only)
 *
 * Does not process PermissionSet / PermissionSetGroup / MutingPermissionSet.
 * Does not import deployment, package, workspace, AI, or SAFE_SKIP services.
 */

'use strict';

const path = require('path');

const PROFILE_META_SUFFIX = '.profile-meta.xml';
const DISCOVERER_ID = 'ProfileRelationshipDiscoverer';
const CUSTOM_OBJECT_SUFFIX = '__c';

const RELATIONSHIPS = Object.freeze({
    OBJECT_PERMISSION: 'ProfileObjectPermission',
    FIELD_PERMISSION_OBJECT: 'ProfileFieldPermissionObject',
    FIELD_PERMISSION: 'ProfileFieldPermission',
    RECORD_TYPE_VISIBILITY: 'ProfileRecordTypeVisibility',
    TAB_VISIBILITY: 'ProfileTabVisibility'
});

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function getProfileName(item) {
    const metadataName = item?.metadataName || item?.name;

    if (metadataName) {
        return String(metadataName).trim();
    }

    const baseName = path.posix.basename(normalizePath(item?.filePath));

    return baseName.endsWith(PROFILE_META_SUFFIX)
        ? baseName.slice(0, -PROFILE_META_SUFFIX.length)
        : null;
}

function resolveProfilePath(item, repoFiles) {
    const itemPath = normalizePath(item?.filePath);

    if (itemPath.endsWith(PROFILE_META_SUFFIX)) {
        return itemPath;
    }

    const profileName = getProfileName(item);

    if (!profileName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedSuffix = `/profiles/${profileName}${PROFILE_META_SUFFIX}`;

    return (
        repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedSuffix)) || null
    );
}

function isCustomObjectName(value) {
    const name = String(value || '').trim();

    return (
        name.endsWith(CUSTOM_OBJECT_SUFFIX) &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    );
}

/**
 * Local equivalent of PermissionSet isCustomTabName.
 * Accepts API names that end with __c or contain an underscore.
 */
function isCustomTabName(value) {
    const name = String(value || '').trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return false;
    }

    return name.endsWith(CUSTOM_OBJECT_SUFFIX) || name.includes('_');
}

/**
 * Local equivalent of PermissionSet parseCustomFieldReference.
 * Accepts only Object__c.Field__c (custom object + custom field).
 */
function parseCustomFieldReference(value) {
    const parts = String(value || '')
        .trim()
        .split('.');

    if (
        parts.length !== 2 ||
        !isCustomObjectName(parts[0]) ||
        !/^[A-Za-z_][A-Za-z0-9_]*__c$/.test(parts[1])
    ) {
        return null;
    }

    return {
        objectName: parts[0],
        fieldName: parts[1],
        fullName: `${parts[0]}.${parts[1]}`
    };
}

/**
 * Local equivalent of PermissionSet parseRecordTypeReference.
 * Accepts ObjectApiName.RecordTypeName for standard and custom objects.
 * Does NOT require __c on the object segment.
 */
function parseRecordTypeReference(value) {
    const parts = String(value || '')
        .trim()
        .split('.');
    const validApiName = /^[A-Za-z_][A-Za-z0-9_]*$/;

    if (
        parts.length !== 2 ||
        !validApiName.test(parts[0]) ||
        !validApiName.test(parts[1])
    ) {
        return null;
    }

    return `${parts[0]}.${parts[1]}`;
}

function extractTagValue(block, tagName) {
    const match = String(block || '').match(
        new RegExp(
            `<(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b[^>]*>\\s*([^<]+?)\\s*<\\/(?:[A-Za-z_][\\w.-]*:)?${tagName}>`,
            'i'
        )
    );

    return match ? String(match[1]).trim() : null;
}

function extractSectionValues(xml, sectionName, valueTag) {
    const values = [];
    const sectionPattern = new RegExp(
        `<(?:[A-Za-z_][\\w.-]*:)?${sectionName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${sectionName}>`,
        'gi'
    );

    for (const match of String(xml || '').matchAll(sectionPattern)) {
        const value = extractTagValue(match[1], valueTag);

        if (value) {
            values.push(value);
        }
    }

    return values;
}

function createRelationshipRecord({
    name,
    metadataType,
    relationship,
    sourceMetadata,
    sourceField = null,
    discoveryMethod,
    reason,
    depth
}) {
    return {
        name,
        metadataType,
        type: metadataType,
        relationship,
        sourceMetadata,
        sourceField,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod,
        required: true,
        selected: true,
        depth,
        reason
    };
}

/**
 * Pure XML → relationships for Profile objectPermissions, fieldPermissions,
 * recordTypeVisibilities, and tabVisibilities.
 * @param {string} xml
 * @param {string} sourceMetadata Profile API name
 * @param {number} [depth=1]
 * @returns {Array<object>}
 */
function discoverProfileRelationships(xml, sourceMetadata, depth = 1) {
    const relationships = new Map();

    function addRelationship(record) {
        const key = `${record.metadataType}:${record.name}`;

        if (!relationships.has(key)) {
            relationships.set(key, record);
        }
    }

    for (const objectName of extractSectionValues(
        xml,
        'objectPermissions',
        'object'
    )) {
        if (!isCustomObjectName(objectName)) {
            continue;
        }

        addRelationship(
            createRelationshipRecord({
                name: objectName,
                metadataType: 'CustomObject',
                relationship: RELATIONSHIPS.OBJECT_PERMISSION,
                sourceMetadata,
                discoveryMethod: 'objectPermissions',
                reason: 'Profile object permission',
                depth
            })
        );
    }

    for (const fieldValue of extractSectionValues(
        xml,
        'fieldPermissions',
        'field'
    )) {
        const fieldReference = parseCustomFieldReference(fieldValue);

        if (!fieldReference) {
            continue;
        }

        addRelationship(
            createRelationshipRecord({
                name: fieldReference.objectName,
                metadataType: 'CustomObject',
                relationship: RELATIONSHIPS.FIELD_PERMISSION_OBJECT,
                sourceMetadata,
                discoveryMethod: 'fieldPermissions',
                reason: 'Profile field permission parent object',
                depth
            })
        );
        addRelationship(
            createRelationshipRecord({
                name: fieldReference.fullName,
                metadataType: 'CustomField',
                relationship: RELATIONSHIPS.FIELD_PERMISSION,
                sourceMetadata,
                discoveryMethod: 'fieldPermissions',
                reason: 'Profile field permission',
                depth
            })
        );
    }

    for (const recordTypeValue of extractSectionValues(
        xml,
        'recordTypeVisibilities',
        'recordType'
    )) {
        const recordTypeName = parseRecordTypeReference(recordTypeValue);

        if (!recordTypeName) {
            continue;
        }

        addRelationship(
            createRelationshipRecord({
                name: recordTypeName,
                metadataType: 'RecordType',
                relationship: RELATIONSHIPS.RECORD_TYPE_VISIBILITY,
                sourceMetadata,
                sourceField: 'recordType',
                discoveryMethod: 'recordTypeVisibilities',
                reason: 'Profile record type visibility',
                depth
            })
        );
    }

    for (const tabName of extractSectionValues(
        xml,
        'tabVisibilities',
        'tab'
    )) {
        if (!isCustomTabName(tabName)) {
            continue;
        }

        addRelationship(
            createRelationshipRecord({
                name: tabName,
                metadataType: 'CustomTab',
                relationship: RELATIONSHIPS.TAB_VISIBILITY,
                sourceMetadata,
                discoveryMethod: 'tabVisibilities',
                reason: 'Profile tab visibility',
                depth
            })
        );
    }

    return [...relationships.values()];
}

const profileRelationshipDiscoverer = {
    id: DISCOVERER_ID,
    discoverProfileRelationships,

    async discover({ selectedMetadata, repoFiles, readRepoFile, depth = 1 }) {
        const relationships = [];
        const warnings = [];
        const scannedPaths = new Set();
        let filesScanned = 0;
        let metadataScanned = 0;

        if (
            !Array.isArray(selectedMetadata) ||
            !Array.isArray(repoFiles) ||
            typeof readRepoFile !== 'function'
        ) {
            return {
                relationships,
                warnings,
                filesScanned,
                metadataScanned
            };
        }

        for (const item of selectedMetadata) {
            if (item?.metadataType !== 'Profile') {
                continue;
            }

            const profileName = getProfileName(item);
            const profilePath = resolveProfilePath(item, repoFiles);

            if (!profileName || !profilePath) {
                warnings.push(
                    `Profile metadata file not found for ${
                        profileName || 'unknown Profile'
                    }.`
                );
                continue;
            }

            if (scannedPaths.has(profilePath)) {
                continue;
            }

            scannedPaths.add(profilePath);
            metadataScanned += 1;
            filesScanned += 1;

            try {
                const xml = await readRepoFile(profilePath);
                const discovered = discoverProfileRelationships(
                    xml,
                    profileName,
                    depth
                );
                relationships.push(...discovered);
            } catch (error) {
                warnings.push(
                    `Unable to read Profile metadata ${profilePath}: ${
                        error?.message || 'unknown error'
                    }`
                );
            }
        }

        return {
            relationships,
            warnings,
            filesScanned,
            metadataScanned
        };
    }
};

module.exports = profileRelationshipDiscoverer;
