const path = require('path');
const {
    resolveRecordTypePicklistStandardValueSet,
    resolveBusinessProcessStandardValueSet
} = require('../../../config/standardValueSetRelationships');

const RECORD_TYPE_META_SUFFIX = '.recordType-meta.xml';
const BUSINESS_PROCESS_META_SUFFIX = '.businessProcess-meta.xml';
const DISCOVERER_ID = 'StandardValueSetDiscoverer';
const DISCOVERY_METHOD = 'standardValueSet';
const RECORD_TYPE_RELATIONSHIP = 'RecordTypeStandardValueSet';
const BUSINESS_PROCESS_RELATIONSHIP = 'BusinessProcessStandardValueSet';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function parseObjectChildIdentity(name) {
    const trimmed = String(name || '').trim();
    const separatorIndex = trimmed.indexOf('.');

    if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
        return null;
    }

    return {
        objectApiName: trimmed.slice(0, separatorIndex).trim(),
        childApiName: trimmed.slice(separatorIndex + 1).trim()
    };
}

function getObjectApiNameFromPath(filePath) {
    const normalizedPath = normalizePath(filePath);
    const objectsSegment = '/objects/';
    const objectsIndex = normalizedPath.indexOf(objectsSegment);

    if (objectsIndex === -1) {
        return null;
    }

    const afterObjects = normalizedPath.slice(
        objectsIndex + objectsSegment.length
    );
    const objectFolderName = afterObjects.split('/')[0];

    return objectFolderName || null;
}

function extractChildApiName(filePath, suffix) {
    const baseName = path.posix.basename(normalizePath(filePath));

    if (!baseName.endsWith(suffix)) {
        return null;
    }

    return baseName.slice(0, -suffix.length);
}

function resolveObjectChildFilePath(
    item,
    repoFiles,
    folderName,
    suffix
) {
    if (
        item?.filePath &&
        normalizePath(item.filePath).endsWith(suffix)
    ) {
        return normalizePath(item.filePath);
    }

    const parsed = parseObjectChildIdentity(getItemName(item));

    if (!parsed || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedFolder = `/objects/${parsed.objectApiName}/${folderName}/`;
    const expectedSuffix = `${parsed.childApiName}${suffix}`;

    return (
        repoFiles
            .map(normalizePath)
            .find(
                (repoFile) =>
                    repoFile.includes(expectedFolder) &&
                    repoFile.endsWith(expectedSuffix)
            ) || null
    );
}

function extractRecordTypePicklistFieldNames(xml) {
    const names = [];
    const seen = new Set();
    const pattern = /<picklist>\s*([^<]+?)\s*<\/picklist>/gi;
    let match;

    while ((match = pattern.exec(String(xml || ''))) !== null) {
        const fieldName = match[1].trim();

        if (!fieldName || seen.has(fieldName)) {
            continue;
        }

        seen.add(fieldName);
        names.push(fieldName);
    }

    return names;
}

function createStandardValueSetRelationship({
    memberName,
    relationship,
    sourceMetadata,
    sourceField,
    depth
}) {
    return {
        name: memberName,
        metadataType: 'StandardValueSet',
        type: 'StandardValueSet',
        relationship,
        sourceMetadata,
        sourceField,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        filePath: null,
        reason:
            `StandardValueSet ${memberName} referenced by ${sourceMetadata}.`
    };
}

function pushUniqueRelationship(relationships, seen, relationship) {
    const key = `StandardValueSet:${relationship.name}`;

    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    relationships.push(relationship);
}

async function discoverFromRecordType({
    item,
    repoFiles,
    readRepoFile,
    depth,
    relationships,
    warnings,
    seen,
    scannedPaths
}) {
    const fieldFilePath = resolveObjectChildFilePath(
        item,
        repoFiles,
        'recordTypes',
        RECORD_TYPE_META_SUFFIX
    );

    if (!fieldFilePath) {
        warnings.push(
            `Unable to resolve RecordType metadata path for ${
                getItemName(item) || 'unknown'
            }.`
        );
        return { filesScanned: 0 };
    }

    if (scannedPaths.has(fieldFilePath)) {
        return { filesScanned: 0 };
    }

    scannedPaths.add(fieldFilePath);

    try {
        const recordTypeXml = await readRepoFile(fieldFilePath);
        const parsedName = parseObjectChildIdentity(getItemName(item));
        const objectApiName =
            getObjectApiNameFromPath(fieldFilePath) ||
            parsedName?.objectApiName ||
            null;
        const sourceRecordType =
            extractChildApiName(fieldFilePath, RECORD_TYPE_META_SUFFIX) ||
            parsedName?.childApiName ||
            null;
        const sourceMetadata = objectApiName && sourceRecordType
            ? `${objectApiName}.${sourceRecordType}`
            : getItemName(item);

        for (const picklistFieldName of extractRecordTypePicklistFieldNames(
            recordTypeXml
        )) {
            const memberName = resolveRecordTypePicklistStandardValueSet(
                objectApiName,
                picklistFieldName
            );

            if (!memberName) {
                continue;
            }

            pushUniqueRelationship(
                relationships,
                seen,
                createStandardValueSetRelationship({
                    memberName,
                    relationship: RECORD_TYPE_RELATIONSHIP,
                    sourceMetadata,
                    sourceField: picklistFieldName,
                    depth
                })
            );
        }
    } catch (error) {
        warnings.push(
            `Unable to read RecordType metadata ${fieldFilePath}: ${
                error?.message || 'unknown error'
            }`
        );
    }

    return { filesScanned: 1 };
}

function discoverFromBusinessProcess({
    item,
    depth,
    relationships,
    seen
}) {
    const parsedName = parseObjectChildIdentity(getItemName(item));
    const objectApiName =
        getObjectApiNameFromPath(item?.filePath) ||
        parsedName?.objectApiName ||
        null;
    const memberName = resolveBusinessProcessStandardValueSet(objectApiName);

    if (!memberName) {
        return;
    }

    pushUniqueRelationship(
        relationships,
        seen,
        createStandardValueSetRelationship({
            memberName,
            relationship: BUSINESS_PROCESS_RELATIONSHIP,
            sourceMetadata: getItemName(item),
            sourceField: 'values',
            depth
        })
    );
}

/**
 * Discover StandardValueSet dependencies from RecordType picklist field
 * references and BusinessProcess object context.
 *
 * Does not emit individual picklist values as metadata members.
 */
const standardValueSetDiscoverer = {
    id: DISCOVERER_ID,
    parseObjectChildIdentity,
    extractRecordTypePicklistFieldNames,

    async discover({ selectedMetadata, repoFiles, readRepoFile, depth = 1 }) {
        const relationships = [];
        const warnings = [];
        const seen = new Set();
        const scannedPaths = new Set();
        let filesScanned = 0;
        let metadataScanned = 0;

        if (!Array.isArray(selectedMetadata) || !Array.isArray(repoFiles)) {
            return {
                relationships,
                warnings,
                filesScanned,
                metadataScanned
            };
        }

        const normalizedRepoFiles = repoFiles.map(normalizePath);

        for (const item of selectedMetadata) {
            const itemType = getItemType(item);

            if (itemType === 'RecordType') {
                metadataScanned += 1;
                const scan = await discoverFromRecordType({
                    item,
                    repoFiles: normalizedRepoFiles,
                    readRepoFile,
                    depth,
                    relationships,
                    warnings,
                    seen,
                    scannedPaths
                });
                filesScanned += scan.filesScanned;
                continue;
            }

            if (itemType === 'BusinessProcess') {
                metadataScanned += 1;
                discoverFromBusinessProcess({
                    item,
                    depth,
                    relationships,
                    seen
                });
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

module.exports = standardValueSetDiscoverer;
