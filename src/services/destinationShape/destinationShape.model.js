/**
 * Destination Shape model — Phase 9B.
 *
 * Structural facts for future CONTRACT evaluation.
 * Does not compare source vs destination or authorize Skip/Deploy.
 */

function buildShapeKey(metadataType, metadataName) {
    return `${metadataType}:${metadataName}`;
}

/**
 * Parse CustomField identity ObjectApiName.FieldApiName.
 *
 * @param {string|null|undefined} metadataName
 * @returns {{
 *   parentObject: string,
 *   fieldApiName: string,
 *   canonicalName: string
 * }|null}
 */
function parseCustomFieldName(metadataName) {
    if (!metadataName || typeof metadataName !== 'string') {
        return null;
    }

    const separatorIndex = metadataName.indexOf('.');

    if (separatorIndex <= 0 || separatorIndex === metadataName.length - 1) {
        return null;
    }

    const parentObject = metadataName.slice(0, separatorIndex).trim();
    const fieldApiName = metadataName.slice(separatorIndex + 1).trim();

    if (!parentObject || !fieldApiName || fieldApiName.includes('.')) {
        return null;
    }

    return {
        parentObject,
        fieldApiName,
        canonicalName: `${parentObject}.${fieldApiName}`
    };
}

function createEmptyDestinationShapeIndex() {
    return {
        shapes: new Map(),
        summary: createEmptyShapeSummary()
    };
}

function createEmptyShapeSummary() {
    return {
        requested: 0,
        resolved: 0,
        missing: 0,
        unknown: 0,
        unsupported: 0,
        objectsDescribed: 0,
        warnings: []
    };
}

/**
 * @param {object} params
 * @returns {object}
 */
function createCustomFieldShapeEntry({
    metadataName,
    parentObject = null,
    fieldApiName = null,
    found = false,
    queried = false,
    attributes = null,
    api = null,
    warning = null,
    unsupported = false
} = {}) {
    return {
        metadataType: 'CustomField',
        metadataName: metadataName || null,
        parentObject,
        apiName: fieldApiName,
        found: found === true,
        queried: queried === true,
        api,
        attributes:
            attributes && typeof attributes === 'object' ? attributes : null,
        warning,
        unsupported: unsupported === true,
        source: 'DESTINATION_SHAPE_BUILDER'
    };
}

/**
 * Map a Salesforce describe field record to deterministic attributes.
 * Pure — no I/O.
 *
 * @param {object|null} fieldDescribe
 * @returns {object|null}
 */
function mapDescribeFieldToAttributes(fieldDescribe) {
    if (!fieldDescribe || typeof fieldDescribe !== 'object') {
        return null;
    }

    const referenceTo = Array.isArray(fieldDescribe.referenceTo)
        ? fieldDescribe.referenceTo.filter((value) => typeof value === 'string')
        : [];

    let picklistValues = null;
    const fieldType = fieldDescribe.type || null;

    if (
        (fieldType === 'picklist' || fieldType === 'multipicklist') &&
        Array.isArray(fieldDescribe.picklistValues)
    ) {
        picklistValues = fieldDescribe.picklistValues.map((entry) => ({
            value: entry?.value ?? null,
            label: entry?.label ?? null,
            active: entry?.active === true,
            defaultValue: entry?.defaultValue === true
        }));
    }

    return {
        type: fieldType,
        length:
            typeof fieldDescribe.length === 'number'
                ? fieldDescribe.length
                : null,
        precision:
            typeof fieldDescribe.precision === 'number'
                ? fieldDescribe.precision
                : null,
        scale:
            typeof fieldDescribe.scale === 'number'
                ? fieldDescribe.scale
                : null,
        // Destination required ≈ not nillable (deterministic describe flag).
        required: fieldDescribe.nillable === false,
        unique: fieldDescribe.unique === true,
        externalId: fieldDescribe.externalId === true,
        referenceTo,
        picklistValues,
        label:
            typeof fieldDescribe.label === 'string'
                ? fieldDescribe.label
                : null,
        calculated: fieldDescribe.calculated === true,
        custom: fieldDescribe.custom === true
    };
}

/**
 * Serialize shape index Maps for JSON responses / diagnostics.
 *
 * @param {object|null} destinationShapeIndex
 * @returns {object}
 */
function serializeDestinationShapeIndex(destinationShapeIndex) {
    const shapes = destinationShapeIndex?.shapes;
    const byType = {};

    if (shapes instanceof Map) {
        for (const entry of shapes.values()) {
            const metadataType = entry?.metadataType || 'Unknown';
            const metadataName = entry?.metadataName;

            if (!metadataName) {
                continue;
            }

            if (!byType[metadataType]) {
                byType[metadataType] = {};
            }

            byType[metadataType][metadataName] = entry;
        }
    }

    return {
        byType,
        summary: destinationShapeIndex?.summary || createEmptyShapeSummary()
    };
}

/**
 * @param {object|null} destinationShapeIndex
 * @param {string} metadataType
 * @param {string} metadataName
 * @returns {object|null}
 */
function getShapeEntry(destinationShapeIndex, metadataType, metadataName) {
    if (!metadataType || !metadataName) {
        return null;
    }

    const shapes = destinationShapeIndex?.shapes;

    if (!(shapes instanceof Map)) {
        return null;
    }

    return shapes.get(buildShapeKey(metadataType, metadataName)) || null;
}

module.exports = {
    buildShapeKey,
    parseCustomFieldName,
    createEmptyDestinationShapeIndex,
    createEmptyShapeSummary,
    createCustomFieldShapeEntry,
    mapDescribeFieldToAttributes,
    serializeDestinationShapeIndex,
    getShapeEntry
};
