/**
 * Profile Relationship Discoverer (Phase 19.2)
 *
 * Profile-specific. Currently discovers only:
 *   objectPermissions → CustomObject (custom __c names)
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
    OBJECT_PERMISSION: 'ProfileObjectPermission'
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
 * Pure XML → relationships for Profile.objectPermissions only.
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
