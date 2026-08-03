const path = require('path');

const FIELD_META_SUFFIX = '.field-meta.xml';
const OBJECT_META_SUFFIX = '.object-meta.xml';
const DISCOVERER_ID = 'CustomObjectRelationshipDiscoverer';
const DISCOVERY_METHOD = 'referenceTo';

const RELATIONSHIP_TYPES = Object.freeze({
    Lookup: 'Lookup',
    MasterDetail: 'MasterDetail',
    Summary: 'Summary'
});

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function getCustomObjectApiName(filePath, metadataName) {
    if (metadataName && !String(metadataName).includes('.')) {
        return String(metadataName).trim();
    }

    const normalizedPath = normalizePath(filePath);
    const baseName = path.posix.basename(normalizedPath);

    if (baseName.endsWith(OBJECT_META_SUFFIX)) {
        return baseName.slice(0, -OBJECT_META_SUFFIX.length);
    }

    const objectsSegment = '/objects/';
    const objectsIndex = normalizedPath.indexOf(objectsSegment);

    if (objectsIndex !== -1) {
        const afterObjects = normalizedPath.slice(
            objectsIndex + objectsSegment.length
        );
        const objectFolderName = afterObjects.split('/')[0];

        if (objectFolderName) {
            return objectFolderName;
        }
    }

    return null;
}

function extractFieldApiName(fieldFilePath) {
    const baseName = path.posix.basename(normalizePath(fieldFilePath));

    if (!baseName.endsWith(FIELD_META_SUFFIX)) {
        return null;
    }

    return baseName.slice(0, -FIELD_META_SUFFIX.length);
}

function isFieldFileForObject(repoFilePath, objectApiName) {
    const normalizedPath = normalizePath(repoFilePath);
    const expectedFolder = `/objects/${objectApiName}/fields/`;

    return (
        normalizedPath.includes(expectedFolder) &&
        normalizedPath.endsWith(FIELD_META_SUFFIX)
    );
}

function resolveCustomFieldFilePath(item, repoFiles) {
    if (item?.filePath && normalizePath(item.filePath).endsWith(FIELD_META_SUFFIX)) {
        return normalizePath(item.filePath);
    }

    const metadataName = item?.metadataName;

    if (!metadataName || !Array.isArray(repoFiles)) {
        return null;
    }

    if (metadataName.includes('.')) {
        const [objectApiName, fieldApiName] = metadataName.split('.');
        const expectedSuffix = `/objects/${objectApiName}/fields/${fieldApiName}${FIELD_META_SUFFIX}`;

        return (
            repoFiles
                .map(normalizePath)
                .find((repoFile) => repoFile.endsWith(expectedSuffix)) || null
        );
    }

    const expectedEnding = `/${metadataName}${FIELD_META_SUFFIX}`;

    return (
        repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedEnding)) || null
    );
}

function extractXmlTagValue(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(content || '').match(pattern);

    return match ? match[1].trim() : null;
}

function isCustomObjectApiName(name) {
    return Boolean(name) && /__c$/i.test(String(name).trim());
}

/**
 * Resolve Roll-Up Summary child object API name.
 *
 * Prefer <summarizedObject>. Otherwise parse <summaryForeignKey>
 * when it is qualified as ChildObject.RelationshipField
 * (e.g. Booking__c.Session__c → Booking__c).
 */
function resolveSummaryReferencedObject(summarizedObject, summaryForeignKey) {
    if (summarizedObject && isCustomObjectApiName(summarizedObject)) {
        return summarizedObject;
    }

    if (summaryForeignKey && String(summaryForeignKey).includes('.')) {
        const childObject = String(summaryForeignKey).split('.')[0].trim();

        if (isCustomObjectApiName(childObject)) {
            return childObject;
        }
    }

    return null;
}

function parseRelationshipFromFieldXml(fieldXml) {
    const fieldType = extractXmlTagValue(fieldXml, 'type');

    if (!fieldType) {
        return null;
    }

    // Roll-Up Summary → child CustomObject via summarizedObject
    // or qualified summaryForeignKey (ChildObject.Field).
    // Does NOT emit the parent object (left side of CustomField name).
    if (fieldType === RELATIONSHIP_TYPES.Summary) {
        const summarizedObject = extractXmlTagValue(
            fieldXml,
            'summarizedObject'
        );
        const summaryForeignKey = extractXmlTagValue(
            fieldXml,
            'summaryForeignKey'
        );
        const referencedObject = resolveSummaryReferencedObject(
            summarizedObject,
            summaryForeignKey
        );

        if (!referencedObject) {
            return null;
        }

        return {
            relationship: RELATIONSHIP_TYPES.Summary,
            referencedObject
        };
    }

    // Lookup / MasterDetail → referenceTo (unchanged).
    const referenceTo = extractXmlTagValue(fieldXml, 'referenceTo');

    if (!referenceTo) {
        return null;
    }

    if (
        fieldType !== RELATIONSHIP_TYPES.Lookup &&
        fieldType !== RELATIONSHIP_TYPES.MasterDetail
    ) {
        return null;
    }

    if (!isCustomObjectApiName(referenceTo)) {
        return null;
    }

    return {
        relationship: fieldType,
        referencedObject: referenceTo
    };
}

function createRelationshipRecord({
    referencedObject,
    relationship,
    sourceMetadata,
    sourceField,
    depth = 1
}) {
    return {
        name: referencedObject,
        metadataType: 'CustomObject',
        type: 'CustomObject',
        relationship,
        sourceMetadata,
        sourceField,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        reason: `${relationship} target discovered from field metadata.`
    };
}

/**
 * Discover Lookup / MasterDetail / Summary referenced CustomObjects from field metadata.
 */
const customObjectRelationshipDiscoverer = {
    id: DISCOVERER_ID,
    parseRelationshipFromFieldXml,

    async discover({ selectedMetadata, repoFiles, readRepoFile, depth = 1 }) {
        const relationships = [];
        const warnings = [];
        const scannedFieldPaths = new Set();
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
            if (!item?.metadataType) {
                continue;
            }

            if (item.metadataType === 'CustomObject') {
                const objectApiName = getCustomObjectApiName(
                    item.filePath,
                    item.metadataName
                );

                if (!objectApiName) {
                    warnings.push(
                        'Unable to resolve CustomObject API name for relationship discovery.'
                    );
                    continue;
                }

                metadataScanned += 1;

                const fieldFiles = normalizedRepoFiles.filter((repoFile) =>
                    isFieldFileForObject(repoFile, objectApiName)
                );

                for (const fieldFilePath of fieldFiles) {
                    if (scannedFieldPaths.has(fieldFilePath)) {
                        continue;
                    }

                    scannedFieldPaths.add(fieldFilePath);
                    filesScanned += 1;

                    try {
                        const fieldXml = await readRepoFile(fieldFilePath);
                        const parsed = parseRelationshipFromFieldXml(fieldXml);

                        if (!parsed) {
                            continue;
                        }

                        const sourceField = extractFieldApiName(fieldFilePath);

                        relationships.push(
                            createRelationshipRecord({
                                referencedObject: parsed.referencedObject,
                                relationship: parsed.relationship,
                                sourceMetadata: objectApiName,
                                sourceField,
                                depth
                            })
                        );
                    } catch (error) {
                        warnings.push(
                            `Unable to read field metadata ${fieldFilePath}: ${
                                error?.message || 'unknown error'
                            }`
                        );
                    }
                }

                continue;
            }

            if (item.metadataType === 'CustomField') {
                const fieldFilePath = resolveCustomFieldFilePath(
                    item,
                    normalizedRepoFiles
                );

                if (!fieldFilePath) {
                    continue;
                }

                if (scannedFieldPaths.has(fieldFilePath)) {
                    continue;
                }

                scannedFieldPaths.add(fieldFilePath);
                metadataScanned += 1;
                filesScanned += 1;

                try {
                    const fieldXml = await readRepoFile(fieldFilePath);
                    const parsed = parseRelationshipFromFieldXml(fieldXml);

                    if (!parsed) {
                        continue;
                    }

                    const sourceField = extractFieldApiName(fieldFilePath);
                    const sourceMetadata =
                        getCustomObjectApiName(fieldFilePath, null) ||
                        (item.metadataName && item.metadataName.includes('.')
                            ? item.metadataName.split('.')[0]
                            : null);

                    relationships.push(
                        createRelationshipRecord({
                            referencedObject: parsed.referencedObject,
                            relationship: parsed.relationship,
                            sourceMetadata,
                            sourceField,
                            depth
                        })
                    );
                } catch (error) {
                    warnings.push(
                        `Unable to read field metadata ${fieldFilePath}: ${
                            error?.message || 'unknown error'
                        }`
                    );
                }
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

module.exports = customObjectRelationshipDiscoverer;
