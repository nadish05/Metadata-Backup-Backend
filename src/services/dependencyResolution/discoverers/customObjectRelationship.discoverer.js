const path = require('path');

const FIELD_META_SUFFIX = '.field-meta.xml';
const OBJECT_META_SUFFIX = '.object-meta.xml';
const DISCOVERER_ID = 'CustomObjectRelationshipDiscoverer';
const DISCOVERY_METHOD = 'referenceTo';
const INTERNAL_DISCOVERY_METHOD = 'objectInternalReference';
const EXPRESSION_DISCOVERY_METHOD = 'expressionFieldReference';

const RELATIONSHIP_TYPES = Object.freeze({
    Lookup: 'Lookup',
    MasterDetail: 'MasterDetail',
    Summary: 'Summary',
    Formula: 'Formula'
});

const STANDARD_FIELDS = Object.freeze(
    new Set([
        'Id',
        'Name',
        'OwnerId',
        'CreatedDate',
        'CreatedById',
        'LastModifiedDate',
        'LastModifiedById',
        'SystemModstamp'
    ])
);

const INTERNAL_OBJECT_SECTIONS = Object.freeze([
    {
        relationship: 'searchResultsFields',
        // Salesforce uses searchResultsAdditionalFields; accept both.
        tags: ['searchResultsFields', 'searchResultsAdditionalFields']
    },
    {
        relationship: 'businessProcesses',
        tags: ['businessProcesses']
    },
    {
        relationship: 'recordTypes',
        tags: ['recordTypes']
    },
    {
        relationship: 'compactLayouts',
        tags: ['compactLayouts']
    }
]);

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

function resolveCustomObjectMetaPath(objectApiName, item, repoFiles) {
    if (
        item?.filePath &&
        normalizePath(item.filePath).endsWith(OBJECT_META_SUFFIX)
    ) {
        return normalizePath(item.filePath);
    }

    if (!objectApiName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedSuffix = `/objects/${objectApiName}/${objectApiName}${OBJECT_META_SUFFIX}`;

    return (
        repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedSuffix)) || null
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

/**
 * Like extractXmlTagValue but allows multi-line formula bodies.
 */
function extractXmlTagValueMultiline(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(content || '').match(pattern);

    return match ? match[1].trim() : null;
}

function extractAllXmlTagValues(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'gi'
    );
    const values = [];
    let match;

    while ((match = pattern.exec(String(content || ''))) !== null) {
        const value = match[1].trim();

        if (value) {
            values.push(value);
        }
    }

    return values;
}

function extractXmlBlocks(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`,
        'gi'
    );
    const blocks = [];
    let match;

    while ((match = pattern.exec(String(content || ''))) !== null) {
        blocks.push(match[1]);
    }

    return blocks;
}

function isCustomObjectApiName(name) {
    return Boolean(name) && /__c$/i.test(String(name).trim());
}

function uniqueStrings(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function isCustomFieldApiToken(token) {
    if (!token) {
        return false;
    }

    const fieldPart = String(token).includes('.')
        ? String(token).split('.').pop()
        : String(token).trim();

    if (!fieldPart || STANDARD_FIELDS.has(fieldPart)) {
        return false;
    }

    return /__c$/i.test(fieldPart);
}

function qualifyCustomFieldName(objectApiName, token) {
    const trimmed = String(token || '').trim();

    if (!trimmed) {
        return null;
    }

    if (trimmed.includes('.')) {
        return trimmed;
    }

    return `${objectApiName}.${trimmed}`;
}

function extractCustomFieldTokens(text) {
    return uniqueStrings(
        String(text || '').match(
            /\b(?:[A-Za-z][\w]*__c\.)?[A-Za-z][\w]*__c\b/g
        ) || []
    ).filter(isCustomFieldApiToken);
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

/**
 * Resolve <summarizedField> to a CustomField API token.
 * Accepts Number_of_Guests__c or Booking__c.Number_of_Guests__c.
 */
function resolveSummarizedFieldToken(summarizedField) {
    const trimmed = String(summarizedField || '').trim();

    if (!trimmed || !isCustomFieldApiToken(trimmed)) {
        return null;
    }

    return trimmed;
}

/**
 * Resolve qualified <summaryForeignKey> Object.Field to a CustomField name.
 * e.g. Booking__c.Session__c → Booking__c.Session__c
 * Unqualified / malformed values return null (existing object discovery unchanged).
 */
function resolveSummaryForeignKeyFieldName(summaryForeignKey) {
    const trimmed = String(summaryForeignKey || '').trim();

    if (!trimmed || !trimmed.includes('.')) {
        return null;
    }

    const parts = trimmed.split('.');

    if (parts.length !== 2) {
        return null;
    }

    const objectName = parts[0].trim();
    const fieldName = parts[1].trim();

    if (!isCustomObjectApiName(objectName) || !isCustomFieldApiToken(fieldName)) {
        return null;
    }

    return `${objectName}.${fieldName}`;
}

/**
 * Map formula relationship token Session__r → Session__c field API name.
 */
function relationshipRefToFieldApiName(relationshipRef) {
    const trimmed = String(relationshipRef || '').trim();

    if (!trimmed.toLowerCase().endsWith('__r')) {
        return null;
    }

    return `${trimmed.slice(0, -3)}__c`;
}

/**
 * Build Session__r → referencedObject map from Lookup/MasterDetail field XML.
 */
function buildRelationshipTargetMapFromFieldXmls(fieldXmlByApiName) {
    const map = new Map();

    if (!(fieldXmlByApiName instanceof Map)) {
        return map;
    }

    for (const [fieldApiName, fieldXml] of fieldXmlByApiName.entries()) {
        const fieldType = extractXmlTagValue(fieldXml, 'type');

        if (
            fieldType !== RELATIONSHIP_TYPES.Lookup &&
            fieldType !== RELATIONSHIP_TYPES.MasterDetail
        ) {
            continue;
        }

        const referenceTo = extractXmlTagValue(fieldXml, 'referenceTo');

        if (!isCustomObjectApiName(referenceTo)) {
            continue;
        }

        if (!String(fieldApiName || '').toLowerCase().endsWith('__c')) {
            continue;
        }

        const relationshipRef = `${String(fieldApiName).slice(0, -3)}__r`;
        map.set(relationshipRef, referenceTo);
    }

    return map;
}

function collectFieldExpressionTexts(fieldXml) {
    const texts = [];
    const formula = extractXmlTagValueMultiline(fieldXml, 'formula');

    if (formula) {
        texts.push(formula);
    }

    for (const block of extractXmlBlocks(fieldXml, 'summaryFilterItems')) {
        const filterField = extractXmlTagValue(block, 'field');

        if (filterField) {
            texts.push(filterField);
        }
    }

    return texts;
}

function shouldDiscoverExpressionFieldDependencies(fieldXml) {
    const fieldType = extractXmlTagValue(fieldXml, 'type');

    if (
        fieldType === RELATIONSHIP_TYPES.Formula ||
        fieldType === RELATIONSHIP_TYPES.Summary
    ) {
        return true;
    }

    return Boolean(extractXmlTagValueMultiline(fieldXml, 'formula'));
}

/**
 * Resolve custom field references inside Formula / Summary filter expressions.
 * Returns qualified CustomField API names (Object.Field__c). Does not emit
 * Lookup / MasterDetail / Summary object-relationship records.
 */
function extractExpressionCustomFieldNames(
    fieldXml,
    ownerObjectApiName,
    relationshipTargetMap = new Map()
) {
    if (!shouldDiscoverExpressionFieldDependencies(fieldXml)) {
        return [];
    }

    const fieldType = extractXmlTagValue(fieldXml, 'type');
    let bareFieldOwner = ownerObjectApiName;

    if (fieldType === RELATIONSHIP_TYPES.Summary) {
        const summarizedObject = extractXmlTagValue(
            fieldXml,
            'summarizedObject'
        );
        const summaryForeignKey = extractXmlTagValue(
            fieldXml,
            'summaryForeignKey'
        );
        const childObject = resolveSummaryReferencedObject(
            summarizedObject,
            summaryForeignKey
        );

        if (childObject) {
            bareFieldOwner = childObject;
        }
    }

    if (!bareFieldOwner) {
        return [];
    }

    const qualified = new Set();

    for (const expressionText of collectFieldExpressionTexts(fieldXml)) {
        const text = String(expressionText || '');

        for (const match of text.matchAll(
            /\b([A-Za-z][\w]*__r)\.([A-Za-z][\w]*__c)\b/gi
        )) {
            const relationshipRef = match[1];
            const fieldApiName = match[2];

            if (!isCustomFieldApiToken(fieldApiName)) {
                continue;
            }

            let relatedObject =
                relationshipTargetMap.get(relationshipRef) || null;

            if (!relatedObject) {
                const relFieldApi = relationshipRefToFieldApiName(
                    relationshipRef
                );

                if (isCustomObjectApiName(relFieldApi)) {
                    // Heuristic fallback when sibling relationship metadata
                    // is unavailable: Session__r → Session__c object.
                    relatedObject = relFieldApi;
                }
            }

            if (!isCustomObjectApiName(relatedObject)) {
                continue;
            }

            qualified.add(`${relatedObject}.${fieldApiName}`);
        }

        for (const match of text.matchAll(
            /\b([A-Za-z][\w]*__c)\.([A-Za-z][\w]*__c)\b/g
        )) {
            const objectName = match[1];
            const fieldApiName = match[2];

            if (
                !isCustomObjectApiName(objectName) ||
                !isCustomFieldApiToken(fieldApiName)
            ) {
                continue;
            }

            qualified.add(`${objectName}.${fieldApiName}`);
        }

        const withoutQualifiedAndRelationships = text
            .replace(/\b[A-Za-z][\w]*__r\.[A-Za-z][\w]*__c\b/gi, ' ')
            .replace(/\b[A-Za-z][\w]*__c\.[A-Za-z][\w]*__c\b/g, ' ');

        for (const match of withoutQualifiedAndRelationships.matchAll(
            /\b([A-Za-z][\w]*__c)\b/g
        )) {
            const token = match[1];

            if (!isCustomFieldApiToken(token)) {
                continue;
            }

            if (token === bareFieldOwner) {
                continue;
            }

            qualified.add(`${bareFieldOwner}.${token}`);
        }
    }

    return [...qualified];
}

/**
 * Emit CustomField dependency records for Formula / Summary expression refs.
 */
function discoverExpressionFieldDependencies({
    fieldXml,
    ownerObjectApiName,
    sourceField = null,
    sourceMetadata = null,
    depth = 1,
    relationshipTargetMap = new Map()
} = {}) {
    if (!fieldXml || !ownerObjectApiName) {
        return [];
    }

    const selfName =
        sourceField && ownerObjectApiName
            ? `${ownerObjectApiName}.${sourceField}`
            : null;
    const fieldType = extractXmlTagValue(fieldXml, 'type');
    const relationship =
        fieldType === RELATIONSHIP_TYPES.Summary
            ? RELATIONSHIP_TYPES.Summary
            : RELATIONSHIP_TYPES.Formula;

    const names = extractExpressionCustomFieldNames(
        fieldXml,
        ownerObjectApiName,
        relationshipTargetMap
    );
    const seen = new Set();
    const discovered = [];

    for (const qualifiedName of names) {
        if (!qualifiedName || seen.has(qualifiedName)) {
            continue;
        }

        if (selfName && qualifiedName === selfName) {
            continue;
        }

        seen.add(qualifiedName);

        discovered.push(
            createRelationshipRecord({
                referencedObject: qualifiedName,
                relationship,
                sourceMetadata: sourceMetadata || ownerObjectApiName,
                sourceField,
                depth,
                metadataType: 'CustomField',
                discoveryMethod: EXPRESSION_DISCOVERY_METHOD,
                reason:
                    relationship === RELATIONSHIP_TYPES.Summary
                        ? 'CustomField referenced by Roll-Up Summary expression.'
                        : 'CustomField referenced by Formula expression.'
            })
        );
    }

    return discovered;
}

function parseRelationshipFromFieldXml(fieldXml) {
    const fieldType = extractXmlTagValue(fieldXml, 'type');

    if (!fieldType) {
        return null;
    }

    // Roll-Up Summary → child CustomObject via summarizedObject
    // or qualified summaryForeignKey (ChildObject.Field).
    // Optionally also captures summarizedField and qualified
    // summaryForeignKey CustomField dependencies.
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

        const summarizedField = resolveSummarizedFieldToken(
            extractXmlTagValue(fieldXml, 'summarizedField')
        );
        const summaryForeignKeyField =
            resolveSummaryForeignKeyFieldName(summaryForeignKey);

        return {
            relationship: RELATIONSHIP_TYPES.Summary,
            referencedObject,
            summarizedField,
            summaryForeignKeyField
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

/**
 * Push relationship records for a parsed field relationship.
 * Summary may also emit CustomField deps for summarizedField and
 * qualified summaryForeignKey.
 */
function pushParsedRelationshipRecords(
    relationships,
    parsed,
    { sourceMetadata, sourceField, depth }
) {
    relationships.push(
        createRelationshipRecord({
            referencedObject: parsed.referencedObject,
            relationship: parsed.relationship,
            sourceMetadata,
            sourceField,
            depth
        })
    );

    if (parsed.relationship !== RELATIONSHIP_TYPES.Summary) {
        return;
    }

    const emittedCustomFields = new Set();

    if (parsed.summarizedField) {
        const summarizedFieldName = qualifyCustomFieldName(
            parsed.referencedObject,
            parsed.summarizedField
        );

        if (
            summarizedFieldName &&
            isCustomFieldApiToken(summarizedFieldName) &&
            !emittedCustomFields.has(summarizedFieldName)
        ) {
            emittedCustomFields.add(summarizedFieldName);
            relationships.push(
                createRelationshipRecord({
                    referencedObject: summarizedFieldName,
                    relationship: RELATIONSHIP_TYPES.Summary,
                    sourceMetadata,
                    sourceField,
                    depth,
                    metadataType: 'CustomField',
                    reason:
                        'Summary summarizedField target discovered from field metadata.'
                })
            );
        }
    }

    if (parsed.summaryForeignKeyField) {
        const foreignKeyFieldName = parsed.summaryForeignKeyField;

        if (
            isCustomFieldApiToken(foreignKeyFieldName) &&
            !emittedCustomFields.has(foreignKeyFieldName)
        ) {
            emittedCustomFields.add(foreignKeyFieldName);
            relationships.push(
                createRelationshipRecord({
                    referencedObject: foreignKeyFieldName,
                    relationship: RELATIONSHIP_TYPES.Summary,
                    sourceMetadata,
                    sourceField,
                    depth,
                    metadataType: 'CustomField',
                    reason:
                        'Summary summaryForeignKey target discovered from field metadata.'
                })
            );
        }
    }
}

function createRelationshipRecord({
    referencedObject,
    relationship,
    sourceMetadata,
    sourceField,
    depth = 1,
    metadataType = 'CustomObject',
    discoveryMethod = DISCOVERY_METHOD,
    reason = null
}) {
    return {
        name: referencedObject,
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
        reason:
            reason ||
            `${relationship} target discovered from field metadata.`
    };
}

function collectFieldTokensFromSections(objectXml, tags) {
    const tokens = [];

    for (const tagName of tags) {
        tokens.push(...extractAllXmlTagValues(objectXml, tagName));

        for (const block of extractXmlBlocks(objectXml, tagName)) {
            tokens.push(...extractCustomFieldTokens(block));
            tokens.push(...extractAllXmlTagValues(block, 'fields'));
            tokens.push(...extractAllXmlTagValues(block, 'fullName'));
        }
    }

    return uniqueStrings(tokens).filter(isCustomFieldApiToken);
}

/**
 * Discover CustomField dependencies referenced inside CustomObject XML
 * (search layouts, nameField, businessProcesses, recordTypes, compactLayouts).
 * Returns existing relationship-record shape (CustomField metadataType).
 */
function discoverInternalObjectDependencies(
    objectXml,
    objectApiName,
    depth = 1
) {
    if (!objectXml || !objectApiName) {
        return [];
    }

    const discovered = [];
    const seen = new Set();

    function addCustomField(fieldToken, relationship) {
        if (!isCustomFieldApiToken(fieldToken)) {
            return;
        }

        const qualifiedName = qualifyCustomFieldName(objectApiName, fieldToken);

        if (!qualifiedName || seen.has(qualifiedName)) {
            return;
        }

        seen.add(qualifiedName);

        const sourceField = qualifiedName.includes('.')
            ? qualifiedName.split('.').pop()
            : qualifiedName;

        discovered.push(
            createRelationshipRecord({
                referencedObject: qualifiedName,
                relationship,
                sourceMetadata: objectApiName,
                sourceField,
                depth,
                metadataType: 'CustomField',
                discoveryMethod: INTERNAL_DISCOVERY_METHOD,
                reason: `CustomField referenced by CustomObject ${relationship}.`
            })
        );
    }

    for (const section of INTERNAL_OBJECT_SECTIONS) {
        for (const token of collectFieldTokensFromSections(
            objectXml,
            section.tags
        )) {
            addCustomField(token, section.relationship);
        }
    }

    // nameField — custom __c only; ignore AutoNumber and standard Name.
    for (const nameFieldBlock of extractXmlBlocks(objectXml, 'nameField')) {
        const nameFieldType = extractXmlTagValue(nameFieldBlock, 'type');

        if (String(nameFieldType || '').toLowerCase() === 'autonumber') {
            continue;
        }

        for (const token of extractCustomFieldTokens(nameFieldBlock)) {
            addCustomField(token, 'nameField');
        }

        for (const token of extractAllXmlTagValues(nameFieldBlock, 'fullName')) {
            addCustomField(token, 'nameField');
        }
    }

    return discovered;
}

/**
 * Discover Lookup / MasterDetail / Summary referenced CustomObjects from field metadata,
 * plus CustomField dependencies referenced inside CustomObject XML.
 */
const customObjectRelationshipDiscoverer = {
    id: DISCOVERER_ID,
    parseRelationshipFromFieldXml,
    discoverInternalObjectDependencies,

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

                const objectMetaPath = resolveCustomObjectMetaPath(
                    objectApiName,
                    item,
                    normalizedRepoFiles
                );

                if (objectMetaPath) {
                    filesScanned += 1;

                    try {
                        const objectXml = await readRepoFile(objectMetaPath);
                        const internalDependencies =
                            discoverInternalObjectDependencies(
                                objectXml,
                                objectApiName,
                                depth
                            );

                        relationships.push(...internalDependencies);
                    } catch (error) {
                        warnings.push(
                            `Unable to read CustomObject metadata ${objectMetaPath}: ${
                                error?.message || 'unknown error'
                            }`
                        );
                    }
                }

                const fieldFiles = normalizedRepoFiles.filter((repoFile) =>
                    isFieldFileForObject(repoFile, objectApiName)
                );
                const fieldXmlByApiName = new Map();
                const fieldEntries = [];

                for (const fieldFilePath of fieldFiles) {
                    if (scannedFieldPaths.has(fieldFilePath)) {
                        continue;
                    }

                    scannedFieldPaths.add(fieldFilePath);
                    filesScanned += 1;

                    try {
                        const fieldXml = await readRepoFile(fieldFilePath);
                        const sourceField = extractFieldApiName(fieldFilePath);

                        if (sourceField) {
                            fieldXmlByApiName.set(sourceField, fieldXml);
                        }

                        fieldEntries.push({
                            fieldFilePath,
                            fieldXml,
                            sourceField
                        });
                    } catch (error) {
                        warnings.push(
                            `Unable to read field metadata ${fieldFilePath}: ${
                                error?.message || 'unknown error'
                            }`
                        );
                    }
                }

                const relationshipTargetMap =
                    buildRelationshipTargetMapFromFieldXmls(fieldXmlByApiName);

                for (const entry of fieldEntries) {
                    const parsed = parseRelationshipFromFieldXml(entry.fieldXml);

                    if (parsed) {
                        pushParsedRelationshipRecords(relationships, parsed, {
                            sourceMetadata: objectApiName,
                            sourceField: entry.sourceField,
                            depth
                        });
                    }

                    // Additive: Formula / Summary expression CustomField deps.
                    relationships.push(
                        ...discoverExpressionFieldDependencies({
                            fieldXml: entry.fieldXml,
                            ownerObjectApiName: objectApiName,
                            sourceField: entry.sourceField,
                            sourceMetadata: objectApiName,
                            depth,
                            relationshipTargetMap
                        })
                    );
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
                    const sourceField = extractFieldApiName(fieldFilePath);
                    const sourceMetadata =
                        getCustomObjectApiName(fieldFilePath, null) ||
                        (item.metadataName && item.metadataName.includes('.')
                            ? item.metadataName.split('.')[0]
                            : null);

                    const parsed = parseRelationshipFromFieldXml(fieldXml);

                    if (parsed) {
                        pushParsedRelationshipRecords(relationships, parsed, {
                            sourceMetadata,
                            sourceField,
                            depth
                        });
                    }

                    let relationshipTargetMap = new Map();

                    if (sourceMetadata) {
                        const siblingXmlByApiName = new Map();
                        const siblingFiles = normalizedRepoFiles.filter(
                            (repoFile) =>
                                isFieldFileForObject(repoFile, sourceMetadata)
                        );

                        for (const siblingPath of siblingFiles) {
                            const siblingField =
                                extractFieldApiName(siblingPath);

                            if (!siblingField) {
                                continue;
                            }

                            if (siblingPath === fieldFilePath) {
                                siblingXmlByApiName.set(
                                    siblingField,
                                    fieldXml
                                );
                                continue;
                            }

                            try {
                                siblingXmlByApiName.set(
                                    siblingField,
                                    await readRepoFile(siblingPath)
                                );
                            } catch (siblingError) {
                                // Best-effort relationship map for __r resolution.
                            }
                        }

                        relationshipTargetMap =
                            buildRelationshipTargetMapFromFieldXmls(
                                siblingXmlByApiName
                            );
                    }

                    relationships.push(
                        ...discoverExpressionFieldDependencies({
                            fieldXml,
                            ownerObjectApiName: sourceMetadata,
                            sourceField,
                            sourceMetadata,
                            depth,
                            relationshipTargetMap
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

customObjectRelationshipDiscoverer.extractExpressionCustomFieldNames =
    extractExpressionCustomFieldNames;
customObjectRelationshipDiscoverer.discoverExpressionFieldDependencies =
    discoverExpressionFieldDependencies;

module.exports = customObjectRelationshipDiscoverer;
