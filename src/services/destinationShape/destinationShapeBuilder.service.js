/**
 * Destination Shape Builder — Phase 9B.
 *
 * Builds a request-scoped destination structural index for future CONTRACT.
 * CustomField-only in this phase. Facts only — no compatibility evaluation.
 *
 * Strategy:
 * - Group CustomField identities by parent object
 * - One REST sObject describe per parent object (not per field)
 * - Extract deterministic field attributes into the shape index
 */

const axios = require('axios');

const {
    buildShapeKey,
    parseCustomFieldName,
    createEmptyDestinationShapeIndex,
    createEmptyShapeSummary,
    createCustomFieldShapeEntry,
    mapDescribeFieldToAttributes,
    serializeDestinationShapeIndex,
    getShapeEntry
} = require('./destinationShape.model');

const SUPPORTED_SHAPE_TYPES = Object.freeze(['CustomField']);

function normalizeCustomFieldItems(items) {
    const byKey = new Map();

    if (!Array.isArray(items)) {
        return [];
    }

    for (const item of items) {
        const metadataType = item?.metadataType || item?.type || null;
        const metadataName = item?.metadataName || item?.name || null;

        if (metadataType !== 'CustomField' || !metadataName) {
            continue;
        }

        const parsed = parseCustomFieldName(metadataName);

        if (!parsed) {
            const key = buildShapeKey('CustomField', metadataName);

            if (!byKey.has(key)) {
                byKey.set(key, {
                    metadataType: 'CustomField',
                    metadataName,
                    parsed: null
                });
            }

            continue;
        }

        const key = buildShapeKey('CustomField', parsed.canonicalName);

        if (!byKey.has(key)) {
            byKey.set(key, {
                metadataType: 'CustomField',
                metadataName: parsed.canonicalName,
                parsed
            });
        }
    }

    return [...byKey.values()].sort((a, b) =>
        a.metadataName.localeCompare(b.metadataName)
    );
}

function groupCustomFieldsByParent(items) {
    const groups = new Map();

    for (const item of items) {
        if (!item.parsed) {
            continue;
        }

        const parentObject = item.parsed.parentObject;

        if (!groups.has(parentObject)) {
            groups.set(parentObject, []);
        }

        groups.get(parentObject).push(item);
    }

    return groups;
}

async function getLatestApiVersion(instanceUrl, accessToken) {
    const response = await axios.get(`${instanceUrl}/services/data/`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        },
        timeout: 15000
    });

    const versions = response.data;

    if (!Array.isArray(versions) || !versions.length) {
        return '59.0';
    }

    return versions[versions.length - 1].version;
}

/**
 * Describe one sObject (one HTTP call per parent object).
 *
 * @returns {Promise<{ fieldsByName: Map<string, object>, warning: string|null }>}
 */
async function describeSObject({
    instanceUrl,
    accessToken,
    apiVersion,
    objectApiName
}) {
    const fieldsByName = new Map();

    try {
        const response = await axios.get(
            `${instanceUrl}/services/data/v${apiVersion}/sobjects/${encodeURIComponent(
                objectApiName
            )}/describe`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                },
                timeout: 30000
            }
        );

        const fields = Array.isArray(response.data?.fields)
            ? response.data.fields
            : [];

        for (const field of fields) {
            if (field?.name) {
                fieldsByName.set(field.name, field);
            }
        }

        return { fieldsByName, warning: null };
    } catch (error) {
        return {
            fieldsByName,
            warning:
                error?.response?.data?.[0]?.message ||
                error?.message ||
                `Unable to describe ${objectApiName}.`
        };
    }
}

function summarizeShapeIndex(shapes) {
    const summary = createEmptyShapeSummary();
    summary.requested = shapes.size;

    for (const entry of shapes.values()) {
        if (entry.unsupported) {
            summary.unsupported += 1;
        }

        if (entry.warning) {
            summary.warnings.push(entry.warning);
        }

        if (!entry.queried) {
            summary.unknown += 1;
            continue;
        }

        if (entry.found) {
            summary.resolved += 1;
        } else if (entry.warning) {
            summary.unknown += 1;
        } else {
            summary.missing += 1;
        }
    }

    return summary;
}

/**
 * Build destination structural shape index for this validation run.
 *
 * @param {object} options
 * @param {Array<object>} [options.items] inventory-like { metadataType, metadataName }
 * @param {string} [options.accessToken]
 * @param {string} [options.instanceUrl]
 * @returns {Promise<{
 *   shapes: Map<string, object>,
 *   summary: object
 * }>}
 */
async function buildDestinationShapeIndex({
    items = [],
    accessToken = null,
    instanceUrl = null
} = {}) {
    const index = createEmptyDestinationShapeIndex();
    const customFieldItems = normalizeCustomFieldItems(items);

    if (!customFieldItems.length) {
        return index;
    }

    if (!accessToken || !instanceUrl) {
        for (const item of customFieldItems) {
            const key = buildShapeKey('CustomField', item.metadataName);

            index.shapes.set(
                key,
                createCustomFieldShapeEntry({
                    metadataName: item.metadataName,
                    parentObject: item.parsed?.parentObject || null,
                    fieldApiName: item.parsed?.fieldApiName || null,
                    found: false,
                    queried: false,
                    attributes: null,
                    warning:
                        'Missing destination credentials; shape not queried.',
                    unsupported: !item.parsed
                })
            );
        }

        index.summary = summarizeShapeIndex(index.shapes);
        return index;
    }

    let apiVersion;

    try {
        apiVersion = await getLatestApiVersion(instanceUrl, accessToken);
    } catch (error) {
        const warning =
            error?.message ||
            'Unable to resolve Salesforce API version for destination shape.';

        for (const item of customFieldItems) {
            const key = buildShapeKey('CustomField', item.metadataName);

            index.shapes.set(
                key,
                createCustomFieldShapeEntry({
                    metadataName: item.metadataName,
                    parentObject: item.parsed?.parentObject || null,
                    fieldApiName: item.parsed?.fieldApiName || null,
                    found: false,
                    queried: false,
                    attributes: null,
                    warning,
                    unsupported: !item.parsed
                })
            );
        }

        index.summary = summarizeShapeIndex(index.shapes);
        return index;
    }

    // Invalid identities — mark unsupported without describe.
    for (const item of customFieldItems) {
        if (item.parsed) {
            continue;
        }

        const key = buildShapeKey('CustomField', item.metadataName);

        index.shapes.set(
            key,
            createCustomFieldShapeEntry({
                metadataName: item.metadataName,
                found: false,
                queried: false,
                attributes: null,
                warning:
                    'CustomField identity must be ObjectApiName.FieldApiName.',
                unsupported: true
            })
        );
    }

    const groups = groupCustomFieldsByParent(customFieldItems);
    let objectsDescribed = 0;

    for (const [parentObject, fieldItems] of groups.entries()) {
        const { fieldsByName, warning } = await describeSObject({
            instanceUrl,
            accessToken,
            apiVersion,
            objectApiName: parentObject
        });

        objectsDescribed += 1;

        for (const item of fieldItems) {
            const key = buildShapeKey('CustomField', item.metadataName);
            const fieldApiName = item.parsed.fieldApiName;

            if (warning && fieldsByName.size === 0) {
                index.shapes.set(
                    key,
                    createCustomFieldShapeEntry({
                        metadataName: item.metadataName,
                        parentObject,
                        fieldApiName,
                        found: false,
                        queried: true,
                        attributes: null,
                        api: 'REST_DESCRIBE',
                        warning
                    })
                );
                continue;
            }

            const fieldDescribe = fieldsByName.get(fieldApiName);

            if (!fieldDescribe) {
                index.shapes.set(
                    key,
                    createCustomFieldShapeEntry({
                        metadataName: item.metadataName,
                        parentObject,
                        fieldApiName,
                        found: false,
                        queried: true,
                        attributes: null,
                        api: 'REST_DESCRIBE',
                        warning: null
                    })
                );
                continue;
            }

            index.shapes.set(
                key,
                createCustomFieldShapeEntry({
                    metadataName: item.metadataName,
                    parentObject,
                    fieldApiName,
                    found: true,
                    queried: true,
                    attributes: mapDescribeFieldToAttributes(fieldDescribe),
                    api: 'REST_DESCRIBE',
                    warning: null
                })
            );
        }
    }

    index.summary = summarizeShapeIndex(index.shapes);
    index.summary.objectsDescribed = objectsDescribed;

    return index;
}

module.exports = {
    SUPPORTED_SHAPE_TYPES,
    buildDestinationShapeIndex,
    mapDescribeFieldToAttributes,
    serializeDestinationShapeIndex,
    getShapeEntry,
    parseCustomFieldName,
    buildShapeKey
};
