const path = require('path');

const RECORD_TYPE_META_SUFFIX = '.recordType-meta.xml';
const DISCOVERER_ID = 'RecordTypeBusinessProcessDiscoverer';
const DISCOVERY_METHOD = 'recordTypeBusinessProcess';
const RELATIONSHIP = 'RecordTypeBusinessProcess';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function extractXmlTagValue(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(content || '').match(pattern);

    return match ? match[1].trim() : null;
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

function extractRecordTypeApiName(filePath) {
    const baseName = path.posix.basename(normalizePath(filePath));

    if (!baseName.endsWith(RECORD_TYPE_META_SUFFIX)) {
        return null;
    }

    return baseName.slice(0, -RECORD_TYPE_META_SUFFIX.length);
}

function resolveRecordTypeFilePath(item, repoFiles) {
    if (
        item?.filePath &&
        normalizePath(item.filePath).endsWith(RECORD_TYPE_META_SUFFIX)
    ) {
        return normalizePath(item.filePath);
    }

    const metadataName = getItemName(item);
    const parsed = parseObjectChildIdentity(metadataName);

    if (!parsed || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedFolder = `/objects/${parsed.objectApiName}/recordTypes/`;
    const expectedSuffix = `${parsed.childApiName}${RECORD_TYPE_META_SUFFIX}`;

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

function createBusinessProcessRelationship({
    objectApiName,
    processName,
    sourceRecordType,
    depth
}) {
    const sourceRecordTypeName = sourceRecordType
        ? `${objectApiName}.${sourceRecordType}`
        : objectApiName;

    return {
        name: `${objectApiName}.${processName}`,
        metadataType: 'BusinessProcess',
        type: 'BusinessProcess',
        relationship: RELATIONSHIP,
        sourceMetadata: sourceRecordTypeName,
        sourceField: 'businessProcess',
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        filePath: null,
        reason: `BusinessProcess referenced by RecordType ${sourceRecordTypeName}.`
    };
}

/**
 * Discover BusinessProcess dependencies from RecordType <businessProcess>.
 * Generic for any object RecordType — does not special-case Opportunity.
 */
const recordTypeBusinessProcessDiscoverer = {
    id: DISCOVERER_ID,
    parseObjectChildIdentity,
    resolveRecordTypeFilePath,

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
            if (getItemType(item) !== 'RecordType') {
                continue;
            }

            metadataScanned += 1;

            const fieldFilePath = resolveRecordTypeFilePath(
                item,
                normalizedRepoFiles
            );

            if (!fieldFilePath) {
                warnings.push(
                    `Unable to resolve RecordType metadata path for ${
                        getItemName(item) || 'unknown'
                    }.`
                );
                continue;
            }

            if (scannedPaths.has(fieldFilePath)) {
                continue;
            }

            scannedPaths.add(fieldFilePath);
            filesScanned += 1;

            try {
                const recordTypeXml = await readRepoFile(fieldFilePath);
                const processName = extractXmlTagValue(
                    recordTypeXml,
                    'businessProcess'
                );

                if (!processName) {
                    continue;
                }

                const parsedName = parseObjectChildIdentity(getItemName(item));
                const objectApiName =
                    getObjectApiNameFromPath(fieldFilePath) ||
                    parsedName?.objectApiName ||
                    null;
                const sourceRecordType =
                    extractRecordTypeApiName(fieldFilePath) ||
                    parsedName?.childApiName ||
                    null;

                if (!objectApiName) {
                    warnings.push(
                        `Unable to resolve parent object for RecordType BusinessProcess on ${fieldFilePath}.`
                    );
                    continue;
                }

                const key = `BusinessProcess:${objectApiName}.${processName}`;

                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                relationships.push(
                    createBusinessProcessRelationship({
                        objectApiName,
                        processName,
                        sourceRecordType,
                        depth
                    })
                );
            } catch (error) {
                warnings.push(
                    `Unable to read RecordType metadata ${fieldFilePath}: ${
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

module.exports = recordTypeBusinessProcessDiscoverer;
