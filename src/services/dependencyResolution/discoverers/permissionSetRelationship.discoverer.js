const path = require('path');

const PERMISSION_SET_META_SUFFIX = '.permissionset-meta.xml';
const DISCOVERER_ID = 'PermissionSetRelationshipDiscoverer';
const CUSTOM_OBJECT_SUFFIX = '__c';

const RELATIONSHIPS = Object.freeze({
    OBJECT_PERMISSION: 'PermissionSetObjectPermission',
    FIELD_PERMISSION_OBJECT: 'PermissionSetFieldPermissionObject',
    FIELD_PERMISSION: 'PermissionSetFieldPermission',
    RECORD_TYPE_VISIBILITY: 'PermissionSetRecordTypeVisibility',
    TAB_SETTING: 'PermissionSetTabSetting'
});

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function getPermissionSetName(item) {
    const metadataName = item?.metadataName || item?.name;

    if (metadataName) {
        return String(metadataName).trim();
    }

    const baseName = path.posix.basename(normalizePath(item?.filePath));

    return baseName.endsWith(PERMISSION_SET_META_SUFFIX)
        ? baseName.slice(0, -PERMISSION_SET_META_SUFFIX.length)
        : null;
}

function resolvePermissionSetPath(item, repoFiles) {
    const itemPath = normalizePath(item?.filePath);

    if (itemPath.endsWith(PERMISSION_SET_META_SUFFIX)) {
        return itemPath;
    }

    const permissionSetName = getPermissionSetName(item);

    if (!permissionSetName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedSuffix =
        `/permissionsets/${permissionSetName}${PERMISSION_SET_META_SUFFIX}`;

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

function isCustomTabName(value) {
    const name = String(value || '').trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return false;
    }

    return name.endsWith(CUSTOM_OBJECT_SUFFIX) || name.includes('_');
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

function discoverPermissionSetRelationships(
    xml,
    sourceMetadata,
    depth = 1
) {
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
                reason: 'PermissionSet object permission',
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
                reason: 'PermissionSet field permission parent object',
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
                reason: 'PermissionSet field permission',
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
                discoveryMethod: 'XML',
                reason: 'PermissionSet record type visibility',
                depth
            })
        );
    }

    for (const tabName of extractSectionValues(xml, 'tabSettings', 'tab')) {
        if (!isCustomTabName(tabName)) {
            continue;
        }

        addRelationship(
            createRelationshipRecord({
                name: tabName,
                metadataType: 'CustomTab',
                relationship: RELATIONSHIPS.TAB_SETTING,
                sourceMetadata,
                discoveryMethod: 'tabSettings',
                reason: 'PermissionSet tab access',
                depth
            })
        );
    }

    return [...relationships.values()];
}

const permissionSetRelationshipDiscoverer = {
    id: DISCOVERER_ID,
    discoverPermissionSetRelationships,

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
            if (item?.metadataType !== 'PermissionSet') {
                continue;
            }

            const permissionSetName = getPermissionSetName(item);
            const permissionSetPath = resolvePermissionSetPath(
                item,
                repoFiles
            );

            if (!permissionSetName || !permissionSetPath) {
                warnings.push(
                    `PermissionSet metadata file not found for ${
                        permissionSetName || 'unknown PermissionSet'
                    }.`
                );
                continue;
            }

            if (scannedPaths.has(permissionSetPath)) {
                continue;
            }

            scannedPaths.add(permissionSetPath);
            metadataScanned += 1;
            filesScanned += 1;

            try {
                const xml = await readRepoFile(permissionSetPath);

                relationships.push(
                    ...discoverPermissionSetRelationships(
                        xml,
                        permissionSetName,
                        depth
                    )
                );
            } catch (error) {
                warnings.push(
                    `Unable to read PermissionSet metadata ${permissionSetPath}: ${
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

module.exports = permissionSetRelationshipDiscoverer;
