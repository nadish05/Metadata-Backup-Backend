const path = require('path');
const {
    logBookingTrace,
    isBookingName
} = require('../../bookingTrace.temp');

const FIELD_META_SUFFIX = '.field-meta.xml';
const OBJECT_META_SUFFIX = '.object-meta.xml';
const DISCOVERER_ID = 'CustomObjectRelationshipDiscoverer';
const DISCOVERY_METHOD = 'referenceTo';

const RELATIONSHIP_TYPES = Object.freeze({
    Lookup: 'Lookup',
    MasterDetail: 'MasterDetail',
    Summary: 'Summary'
});

/**
 * TEMPORARY DEBUG — Phase 10.14 Roll-Up Field Parser Investigation.
 * Console logging only. Does not change discovery behavior.
 */
function logRollupParserTrace(section, details = {}) {
    console.log('====================================================');
    console.log(`ROLLUP FIELD PARSER TRACE — ${section}`);
    console.log('====================================================');

    for (const [key, value] of Object.entries(details)) {
        console.log(`${key}:`);
        if (value !== null && typeof value === 'object') {
            try {
                console.log(JSON.stringify(value, null, 2));
            } catch (error) {
                console.log(value);
            }
        } else {
            console.log(value === undefined ? '(undefined)' : value);
        }
    }

    console.log('====================================================');
}

function isBookedSlotsField(metadataName, fieldFilePath, sourceField) {
    const name = String(metadataName || '');
    const filePath = String(fieldFilePath || '').replace(/\\/g, '/');
    const field = String(sourceField || '');

    return (
        name.includes('Booked_Slots__c') ||
        field === 'Booked_Slots__c' ||
        filePath.includes('/Booked_Slots__c.field-meta.xml')
    );
}

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

function parseRelationshipFromFieldXml(fieldXml) {
    const fieldType = extractXmlTagValue(fieldXml, 'type');
    const referenceTo = extractXmlTagValue(fieldXml, 'referenceTo');
    const summarizedObject = extractXmlTagValue(fieldXml, 'summarizedObject');
    const summaryForeignKey = extractXmlTagValue(fieldXml, 'summaryForeignKey');
    const relationshipName = extractXmlTagValue(fieldXml, 'relationshipName');

    // TEMPORARY DEBUG — Phase 10.14 PART C
    logRollupParserTrace('PART C — inside parseRelationshipFromFieldXml()', {
        'field type': fieldType,
        'is Summary': fieldType === RELATIONSHIP_TYPES.Summary,
        'is Lookup': fieldType === RELATIONSHIP_TYPES.Lookup,
        'is MasterDetail': fieldType === RELATIONSHIP_TYPES.MasterDetail,
        type: fieldType,
        referenceTo,
        summarizedObject,
        summaryForeignKey,
        relationshipName,
        'xml present': Boolean(fieldXml),
        'xml length': fieldXml ? String(fieldXml).length : 0
    });

    if (!fieldType) {
        // TEMPORARY DEBUG — Phase 10.14 PART D
        logRollupParserTrace('PART D — parser returns null', {
            WHY: 'Missing XML / missing <type> tag',
            condition: 'Early return: !fieldType'
        });
        return null;
    }

    // Roll-Up Summary → child CustomObject via summarizedObject.
    // Requires both summarizedObject and summaryForeignKey.
    // Does NOT emit the parent object (left side of CustomField name).
    if (fieldType === RELATIONSHIP_TYPES.Summary) {
        if (!summarizedObject || !summaryForeignKey) {
            logRollupParserTrace('PART D — parser returns null', {
                WHY: 'Malformed Summary — missing summarizedObject or summaryForeignKey',
                summarizedObject,
                summaryForeignKey,
                condition:
                    'Early return: Summary && (!summarizedObject || !summaryForeignKey)'
            });
            return null;
        }

        if (!isCustomObjectApiName(summarizedObject)) {
            logRollupParserTrace('PART D — parser returns null', {
                WHY: 'Unsupported type / invalid summarizedObject API name',
                summarizedObject,
                condition: 'Early return: !isCustomObjectApiName(summarizedObject)'
            });
            return null;
        }

        return {
            relationship: RELATIONSHIP_TYPES.Summary,
            referencedObject: summarizedObject
        };
    }

    // Lookup / MasterDetail → referenceTo (unchanged).
    if (!referenceTo) {
        logRollupParserTrace('PART D — parser returns null', {
            WHY: 'Missing XML / missing <referenceTo> for non-Summary field',
            fieldType,
            condition: 'Early return: !referenceTo (Lookup/MasterDetail path)'
        });
        return null;
    }

    if (
        fieldType !== RELATIONSHIP_TYPES.Lookup &&
        fieldType !== RELATIONSHIP_TYPES.MasterDetail
    ) {
        logRollupParserTrace('PART D — parser returns null', {
            WHY: 'Unsupported type',
            fieldType,
            condition:
                'Early return: type is not Lookup, MasterDetail, or handled Summary'
        });
        return null;
    }

    if (!isCustomObjectApiName(referenceTo)) {
        logRollupParserTrace('PART D — parser returns null', {
            WHY: 'Unsupported type / invalid referenceTo API name',
            referenceTo,
            condition: 'Early return: !isCustomObjectApiName(referenceTo)'
        });
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

        // TEMPORARY DEBUG — Phase 10.14 Booked_Slots lifecycle flags
        const bookedSlotsLifecycle = {
            xmlLoaded: false,
            parserCalled: false,
            summaryValuesExtracted: false,
            relationshipObjectCreated: false,
            relationshipAdded: false,
            whyNot: null
        };

        if (!Array.isArray(selectedMetadata) || !Array.isArray(repoFiles)) {
            logRollupParserTrace('PART A — discover entry aborted', {
                WHY: 'selectedMetadata or repoFiles not arrays',
                selectedMetadataIsArray: Array.isArray(selectedMetadata),
                repoFilesIsArray: Array.isArray(repoFiles)
            });

            return {
                relationships,
                warnings,
                filesScanned,
                metadataScanned
            };
        }

        const normalizedRepoFiles = repoFiles.map(normalizePath);

        // TEMPORARY DEBUG — frontier CustomField inventory (Booked_Slots focus)
        const frontierCustomFields = selectedMetadata.filter(
            (item) => item?.metadataType === 'CustomField'
        );
        logRollupParserTrace('PART A — frontier CustomField inventory', {
            'CustomField count in frontier': frontierCustomFields.length,
            'CustomField names': frontierCustomFields.map(
                (item) => item.metadataName || item.name || null
            ),
            'Booked_Slots__c in frontier': frontierCustomFields.some((item) =>
                isBookedSlotsField(item.metadataName || item.name)
            )
        });

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
                        const sourceField = extractFieldApiName(fieldFilePath);
                        const metadataName = `${objectApiName}.${sourceField}`;
                        const fieldType = extractXmlTagValue(fieldXml, 'type');
                        const isBookedSlots = isBookedSlotsField(
                            metadataName,
                            fieldFilePath,
                            sourceField
                        );

                        if (isBookedSlots) {
                            bookedSlotsLifecycle.xmlLoaded = true;
                        }

                        // TEMPORARY DEBUG — Phase 10.14 PART A
                        logRollupParserTrace(
                            'PART A — CustomField XML discovered',
                            {
                                'metadata name': metadataName,
                                'field type': fieldType,
                                path: fieldFilePath,
                                caller: 'CustomObject field scan'
                            }
                        );

                        // TEMPORARY DEBUG — Phase 10.14 PART B
                        logRollupParserTrace(
                            'PART B — before parseRelationshipFromFieldXml()',
                            {
                                'metadata name': metadataName,
                                'field type': fieldType,
                                caller:
                                    'customObjectRelationshipDiscoverer.discover (CustomObject fields)',
                                path: fieldFilePath
                            }
                        );

                        if (isBookedSlots) {
                            bookedSlotsLifecycle.parserCalled = true;
                        }

                        const parsed = parseRelationshipFromFieldXml(fieldXml);

                        // TEMPORARY DEBUG — Phase 10.14 PART E
                        logRollupParserTrace(
                            'PART E — after parseRelationshipFromFieldXml()',
                            {
                                'metadata name': metadataName,
                                'returned object': parsed,
                                path: fieldFilePath
                            }
                        );

                        if (
                            isBookedSlots &&
                            parsed &&
                            parsed.relationship === 'Summary'
                        ) {
                            bookedSlotsLifecycle.summaryValuesExtracted = true;
                        }

                        // TEMPORARY DEBUG — Phase 10.13 Part 1
                        if (parsed && parsed.relationship === 'Summary') {
                            const relationshipRecord = createRelationshipRecord({
                                referencedObject: parsed.referencedObject,
                                relationship: parsed.relationship,
                                sourceMetadata: objectApiName,
                                sourceField,
                                depth
                            });

                            logBookingTrace({
                                stage: 'PART 1 — parseRelationshipFromFieldXml (Summary)',
                                collection: 'parsed Summary relationship',
                                contains: isBookingName(parsed.referencedObject),
                                matches: isBookingName(parsed.referencedObject)
                                    ? [relationshipRecord]
                                    : [],
                                caller: 'customObjectRelationshipDiscoverer.discover',
                                method: 'parseRelationshipFromFieldXml',
                                index: fieldFilePath,
                                extra: {
                                    summarizedObject: parsed.referencedObject,
                                    relationship: parsed.relationship,
                                    relationshipRecord
                                }
                            });
                        }

                        if (!parsed) {
                            if (isBookedSlots && !bookedSlotsLifecycle.whyNot) {
                                bookedSlotsLifecycle.whyNot =
                                    'Parser returned null for Booked_Slots__c';
                            }
                            continue;
                        }

                        if (isBookedSlots) {
                            bookedSlotsLifecycle.relationshipObjectCreated = true;
                        }

                        relationships.push(
                            createRelationshipRecord({
                                referencedObject: parsed.referencedObject,
                                relationship: parsed.relationship,
                                sourceMetadata: objectApiName,
                                sourceField,
                                depth
                            })
                        );

                        if (isBookedSlots) {
                            bookedSlotsLifecycle.relationshipAdded = true;
                        }
                    } catch (error) {
                        warnings.push(
                            `Unable to read field metadata ${fieldFilePath}: ${
                                error?.message || 'unknown error'
                            }`
                        );

                        if (
                            isBookedSlotsField(
                                null,
                                fieldFilePath,
                                extractFieldApiName(fieldFilePath)
                            )
                        ) {
                            bookedSlotsLifecycle.whyNot = `XML read failed: ${
                                error?.message || 'unknown error'
                            }`;
                        }
                    }
                }

                continue;
            }

            if (item.metadataType === 'CustomField') {
                const metadataName = item.metadataName || item.name || null;
                const isBookedSlots = isBookedSlotsField(metadataName);
                const fieldFilePath = resolveCustomFieldFilePath(
                    item,
                    normalizedRepoFiles
                );

                if (!fieldFilePath) {
                    // TEMPORARY DEBUG — Phase 10.14 PART A (path unresolved)
                    logRollupParserTrace(
                        'PART A — CustomField path NOT resolved (XML never loaded)',
                        {
                            'metadata name': metadataName,
                            'field type': '(unknown — file not loaded)',
                            path: null,
                            itemFilePath: item.filePath || null,
                            WHY: 'resolveCustomFieldFilePath returned null',
                            'is Booked_Slots__c': isBookedSlots
                        }
                    );

                    if (isBookedSlots) {
                        bookedSlotsLifecycle.whyNot =
                            'Booked_Slots__c CustomField was in frontier but field-meta.xml path was not resolved — parser never called';
                    }

                    continue;
                }

                if (scannedFieldPaths.has(fieldFilePath)) {
                    if (isBookedSlots) {
                        logRollupParserTrace(
                            'PART A — Booked_Slots__c skipped (already scanned)',
                            {
                                'metadata name': metadataName,
                                path: fieldFilePath
                            }
                        );
                    }
                    continue;
                }

                scannedFieldPaths.add(fieldFilePath);
                metadataScanned += 1;
                filesScanned += 1;

                try {
                    const fieldXml = await readRepoFile(fieldFilePath);
                    const fieldType = extractXmlTagValue(fieldXml, 'type');
                    const sourceField = extractFieldApiName(fieldFilePath);

                    if (isBookedSlots) {
                        bookedSlotsLifecycle.xmlLoaded = true;
                    }

                    // TEMPORARY DEBUG — Phase 10.14 PART A
                    logRollupParserTrace(
                        'PART A — CustomField XML discovered',
                        {
                            'metadata name': metadataName,
                            'field type': fieldType,
                            path: fieldFilePath,
                            caller: 'CustomField frontier item'
                        }
                    );

                    // TEMPORARY DEBUG — Phase 10.14 PART B
                    logRollupParserTrace(
                        'PART B — before parseRelationshipFromFieldXml()',
                        {
                            'metadata name': metadataName,
                            'field type': fieldType,
                            caller:
                                'customObjectRelationshipDiscoverer.discover (CustomField item)',
                            path: fieldFilePath
                        }
                    );

                    if (isBookedSlots) {
                        bookedSlotsLifecycle.parserCalled = true;
                    }

                    const parsed = parseRelationshipFromFieldXml(fieldXml);

                    // TEMPORARY DEBUG — Phase 10.14 PART E
                    logRollupParserTrace(
                        'PART E — after parseRelationshipFromFieldXml()',
                        {
                            'metadata name': metadataName,
                            'returned object': parsed,
                            path: fieldFilePath
                        }
                    );

                    if (
                        isBookedSlots &&
                        parsed &&
                        parsed.relationship === 'Summary'
                    ) {
                        bookedSlotsLifecycle.summaryValuesExtracted = true;
                    }

                    // TEMPORARY DEBUG — Phase 10.13 Part 1
                    if (parsed && parsed.relationship === 'Summary') {
                        const sourceMetadata =
                            getCustomObjectApiName(fieldFilePath, null) ||
                            (item.metadataName &&
                            item.metadataName.includes('.')
                                ? item.metadataName.split('.')[0]
                                : null);
                        const relationshipRecord = createRelationshipRecord({
                            referencedObject: parsed.referencedObject,
                            relationship: parsed.relationship,
                            sourceMetadata,
                            sourceField,
                            depth
                        });

                        logBookingTrace({
                            stage: 'PART 1 — parseRelationshipFromFieldXml (Summary)',
                            collection: 'parsed Summary relationship',
                            contains: isBookingName(parsed.referencedObject),
                            matches: isBookingName(parsed.referencedObject)
                                ? [relationshipRecord]
                                : [],
                            caller: 'customObjectRelationshipDiscoverer.discover',
                            method: 'parseRelationshipFromFieldXml',
                            index: fieldFilePath,
                            extra: {
                                summarizedObject: parsed.referencedObject,
                                relationship: parsed.relationship,
                                relationshipRecord
                            }
                        });
                    }

                    if (!parsed) {
                        if (isBookedSlots && !bookedSlotsLifecycle.whyNot) {
                            bookedSlotsLifecycle.whyNot =
                                'Parser returned null for Booked_Slots__c';
                        }
                        continue;
                    }

                    if (isBookedSlots) {
                        bookedSlotsLifecycle.relationshipObjectCreated = true;
                    }

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

                    if (isBookedSlots) {
                        bookedSlotsLifecycle.relationshipAdded = true;
                    }
                } catch (error) {
                    warnings.push(
                        `Unable to read field metadata ${fieldFilePath}: ${
                            error?.message || 'unknown error'
                        }`
                    );

                    if (isBookedSlots) {
                        bookedSlotsLifecycle.whyNot = `XML read failed: ${
                            error?.message || 'unknown error'
                        }`;
                    }
                }
            }
        }

        if (!bookedSlotsLifecycle.xmlLoaded && !bookedSlotsLifecycle.whyNot) {
            bookedSlotsLifecycle.whyNot =
                'Booked_Slots__c field-meta.xml was never loaded — field not in frontier as CustomField/CustomObject scan target, or path unresolved';
        }

        // TEMPORARY DEBUG — Phase 10.14 final lifecycle
        logRollupParserTrace('FINAL LIFECYCLE — Booked_Slots__c', {
            'Booked_Slots XML loaded?': bookedSlotsLifecycle.xmlLoaded
                ? 'YES'
                : 'NO',
            'Parser called?': bookedSlotsLifecycle.parserCalled ? 'YES' : 'NO',
            'Summary values extracted?':
                bookedSlotsLifecycle.summaryValuesExtracted ? 'YES' : 'NO',
            'Relationship object created?':
                bookedSlotsLifecycle.relationshipObjectCreated ? 'YES' : 'NO',
            'Relationship added?': bookedSlotsLifecycle.relationshipAdded
                ? 'YES'
                : 'NO',
            'Why not?': bookedSlotsLifecycle.whyNot || '(n/a — success or N/A)',
            'relationships emitted this discover call': relationships.map(
                (item) => `${item.relationship}:${item.name}`
            )
        });

        return {
            relationships,
            warnings,
            filesScanned,
            metadataScanned
        };
    }
};

module.exports = customObjectRelationshipDiscoverer;
