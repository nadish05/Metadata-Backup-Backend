/**
 * Request-scoped index of destination parent-object childRelationships
 * for FlexiPage dynamic related-list compatibility (one describe per parent).
 */

const {
    describeSObject,
    getLatestApiVersion
} = require('../destinationShape/destinationShapeBuilder.service');

/**
 * @param {Array<object>} childRelationships
 * @param {string} relatedListApiName
 * @returns {boolean}
 */
function parentHasRelatedListRelationship(childRelationships, relatedListApiName) {
    const normalizedApi = String(relatedListApiName || '').trim();

    if (!normalizedApi || !Array.isArray(childRelationships)) {
        return false;
    }

    const relationshipStem = normalizedApi.endsWith('__r')
        ? normalizedApi.slice(0, -3)
        : normalizedApi;

    for (const entry of childRelationships) {
        const relName = String(entry?.relationshipName || '').trim();

        if (!relName) {
            continue;
        }

        if (relName === normalizedApi || relName === relationshipStem) {
            return true;
        }

        if (`${relName}__r` === normalizedApi) {
            return true;
        }
    }

    return false;
}

function collectFlexiPageRelatedListParentObjects(discoveredReferences = []) {
    const parents = new Set();

    for (const reference of discoveredReferences) {
        if (reference?.referenceType !== 'FlexiPageDynamicRelatedList') {
            continue;
        }

        const parent = String(reference?.sobjectType || '').trim();

        if (parent) {
            parents.add(parent);
        }
    }

    return [...parents].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {object} options
 * @param {Array<object>} [options.discoveredReferences]
 * @param {string|null} [options.accessToken]
 * @param {string|null} [options.instanceUrl]
 * @returns {Promise<Map<string, { queried: boolean, ok: boolean, warning: string|null, childRelationships: Array<object> }>>}
 */
async function buildFlexiPageParentObjectRelationshipIndex({
    discoveredReferences = [],
    accessToken = null,
    instanceUrl = null
} = {}) {
    const index = new Map();
    const parentObjects = collectFlexiPageRelatedListParentObjects(
        discoveredReferences
    );

    if (!parentObjects.length) {
        return index;
    }

    if (!accessToken || !instanceUrl) {
        for (const parentObject of parentObjects) {
            index.set(parentObject, {
                queried: false,
                ok: false,
                warning:
                    'Missing destination credentials; parent object schema not queried.',
                childRelationships: []
            });
        }

        return index;
    }

    let apiVersion;

    try {
        apiVersion = await getLatestApiVersion(instanceUrl, accessToken);
    } catch (error) {
        const warning =
            error?.message ||
            'Unable to resolve Salesforce API version for parent object describe.';

        for (const parentObject of parentObjects) {
            index.set(parentObject, {
                queried: true,
                ok: false,
                warning,
                childRelationships: []
            });
        }

        return index;
    }

    for (const parentObject of parentObjects) {
        const { childRelationships, warning } = await describeSObject({
            instanceUrl,
            accessToken,
            apiVersion,
            objectApiName: parentObject
        });

        if (warning) {
            index.set(parentObject, {
                queried: true,
                ok: false,
                warning,
                childRelationships: []
            });
            continue;
        }

        index.set(parentObject, {
            queried: true,
            ok: true,
            warning: null,
            childRelationships: Array.isArray(childRelationships)
                ? childRelationships
                : []
        });
    }

    return index;
}

module.exports = {
    buildFlexiPageParentObjectRelationshipIndex,
    collectFlexiPageRelatedListParentObjects,
    parentHasRelatedListRelationship
};
