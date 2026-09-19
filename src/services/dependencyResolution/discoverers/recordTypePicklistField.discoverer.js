const path = require('path');

const recordTypeBusinessProcessDiscoverer = require('./recordTypeBusinessProcess.discoverer');

const RECORD_TYPE_META_SUFFIX = '.recordType-meta.xml';
const DISCOVERER_ID = 'RecordTypePicklistFieldDiscoverer';
const DISCOVERY_METHOD = 'recordTypePicklistField';
const RELATIONSHIP = 'RecordTypePicklistField';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
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

function isCustomFieldApiName(fieldApiName) {
    return /__c$/i.test(String(fieldApiName || '').trim());
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

function resolveCustomFieldFilePath(objectApiName, fieldApiName, repoFiles) {
    if (!objectApiName || !fieldApiName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedFolder = `/objects/${objectApiName}/fields/`;
    const expectedSuffix = `/${fieldApiName}.field-meta.xml`;

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

function createCustomFieldRelationship({
    objectApiName,
    fieldApiName,
    sourceRecordTypeName,
    depth
}) {
    const qualifiedName = `${objectApiName}.${fieldApiName}`;

    return {
        name: qualifiedName,
        metadataType: 'CustomField',
        type: 'CustomField',
        relationship: RELATIONSHIP,
        sourceMetadata: sourceRecordTypeName,
        sourceField: fieldApiName,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        filePath: null,
        reason:
            `CustomField ${qualifiedName} referenced by RecordType picklist on ${sourceRecordTypeName}.`
    };
}

/**
 * Discover CustomField dependencies from RecordType <picklist> for custom fields (__c).
 * Standard picklists continue to be handled by the StandardValueSet discoverer.
 */
const recordTypePicklistFieldDiscoverer = {
    id: DISCOVERER_ID,
    extractRecordTypePicklistFieldNames,
    isCustomFieldApiName,
    resolveCustomFieldFilePath,

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
        const { resolveRecordTypeFilePath, parseObjectChildIdentity } =
            recordTypeBusinessProcessDiscoverer;

        for (const item of selectedMetadata) {
            if (getItemType(item) !== 'RecordType') {
                continue;
            }

            metadataScanned += 1;

            const recordTypeFilePath = resolveRecordTypeFilePath(
                item,
                normalizedRepoFiles
            );

            if (!recordTypeFilePath) {
                warnings.push(
                    `Unable to resolve RecordType metadata path for ${
                        getItemName(item) || 'unknown'
                    }.`
                );
                continue;
            }

            if (scannedPaths.has(recordTypeFilePath)) {
                continue;
            }

            scannedPaths.add(recordTypeFilePath);
            filesScanned += 1;

            try {
                const recordTypeXml = await readRepoFile(recordTypeFilePath);
                const picklistFields =
                    extractRecordTypePicklistFieldNames(recordTypeXml);

                if (!picklistFields.length) {
                    continue;
                }

                const parsedName = parseObjectChildIdentity(getItemName(item));
                const objectApiName =
                    getObjectApiNameFromPath(recordTypeFilePath) ||
                    parsedName?.objectApiName ||
                    null;
                const recordTypeApiName =
                    extractRecordTypeApiName(recordTypeFilePath) ||
                    parsedName?.childApiName ||
                    null;

                if (!objectApiName || !recordTypeApiName) {
                    warnings.push(
                        `Unable to resolve parent object for RecordType picklist fields on ${recordTypeFilePath}.`
                    );
                    continue;
                }

                const sourceRecordTypeName = `${objectApiName}.${recordTypeApiName}`;

                for (const fieldApiName of picklistFields) {
                    if (!isCustomFieldApiName(fieldApiName)) {
                        continue;
                    }

                    const fieldFilePath = resolveCustomFieldFilePath(
                        objectApiName,
                        fieldApiName,
                        normalizedRepoFiles
                    );

                    if (!fieldFilePath) {
                        continue;
                    }

                    const key = `CustomField:${objectApiName}.${fieldApiName}`;

                    if (seen.has(key)) {
                        continue;
                    }

                    seen.add(key);
                    relationships.push(
                        createCustomFieldRelationship({
                            objectApiName,
                            fieldApiName,
                            sourceRecordTypeName,
                            depth
                        })
                    );
                }
            } catch (error) {
                warnings.push(
                    `Unable to read RecordType metadata ${recordTypeFilePath}: ${
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

module.exports = recordTypePicklistFieldDiscoverer;
