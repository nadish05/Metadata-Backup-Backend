/**
 * Resolve SOQL child relationship FROM tokens (ChildRel__r) to child object
 * API names using Lookup / MasterDetail field metadata relationshipName.
 */

const FIELD_META_SUFFIX = '.field-meta.xml';

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

function extractAllXmlTagValues(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'gi'
    );
    const values = [];
    let match;

    while ((match = pattern.exec(String(content || ''))) !== null) {
        const value = String(match[1] || '').trim();

        if (value) {
            values.push(value);
        }
    }

    return values;
}

function extractLookupOrMasterDetailReferenceTo(fieldXml) {
    const fieldType = extractXmlTagValue(fieldXml, 'type');

    if (
        fieldType !== 'Lookup' &&
        fieldType !== 'MasterDetail' &&
        fieldType !== 'ExternalLookup'
    ) {
        return [];
    }

    return extractAllXmlTagValues(fieldXml, 'referenceTo');
}

function childRelationshipMapKey(parentObjectApiName, relationshipFromToken) {
    return `${parentObjectApiName}.${relationshipFromToken}`;
}

function relationshipNameToFromToken(relationshipName) {
    const name = String(relationshipName || '').trim();

    if (!name) {
        return null;
    }

    if (/__r$/i.test(name)) {
        return name;
    }

    return `${name}__r`;
}

function getObjectApiNameFromFieldPath(fieldFilePath) {
    const normalized = normalizePath(fieldFilePath);
    const marker = '/objects/';
    const index = normalized.indexOf(marker);

    if (index === -1) {
        return null;
    }

    const after = normalized.slice(index + marker.length);
    const objectFolder = after.split('/')[0];

    return objectFolder || null;
}

/**
 * @param {Map<string, string>|null|undefined} childRelationshipTargets
 * @param {string} parentObjectApiName
 * @param {string} relationshipFromToken e.g. Equipment_Maintenance_Items__r
 * @returns {string|null} child object API name
 */
function resolveChildRelationshipObject(
    childRelationshipTargets,
    parentObjectApiName,
    relationshipFromToken
) {
    if (!(childRelationshipTargets instanceof Map)) {
        return null;
    }

    const wanted = childRelationshipMapKey(
        parentObjectApiName,
        relationshipFromToken
    );
    const direct = childRelationshipTargets.get(wanted);

    if (direct) {
        return direct;
    }

    const wantedLower = wanted.toLowerCase();

    for (const [key, value] of childRelationshipTargets.entries()) {
        if (String(key).toLowerCase() === wantedLower && value) {
            return value;
        }
    }

    return null;
}

/**
 * Build Map<"ParentObject.ChildRel__r", "ChildObject__c"> from field metadata.
 *
 * @param {{
 *   repoFiles: string[],
 *   readRepoFile: (path: string) => Promise<string>,
 *   normalizeObjectApiName?: (name: string) => string
 * }} options
 * @returns {Promise<Map<string, string>>}
 */
async function buildChildRelationshipTargetMap({
    repoFiles,
    readRepoFile,
    normalizeObjectApiName = (name) => name
}) {
    const map = new Map();

    if (!Array.isArray(repoFiles) || typeof readRepoFile !== 'function') {
        return map;
    }

    const fieldFiles = repoFiles
        .map(normalizePath)
        .filter((filePath) => filePath.endsWith(FIELD_META_SUFFIX));

    for (const fieldPath of fieldFiles) {
        const childObjectApiName = getObjectApiNameFromFieldPath(fieldPath);

        if (!childObjectApiName) {
            continue;
        }

        let fieldXml;

        try {
            fieldXml = await readRepoFile(fieldPath);
        } catch (_error) {
            continue;
        }

        const fieldType = extractXmlTagValue(fieldXml, 'type');

        if (
            fieldType !== 'Lookup' &&
            fieldType !== 'MasterDetail' &&
            fieldType !== 'ExternalLookup'
        ) {
            continue;
        }

        const relationshipName = extractXmlTagValue(
            fieldXml,
            'relationshipName'
        );
        const referenceToValues =
            extractLookupOrMasterDetailReferenceTo(fieldXml);

        if (!relationshipName || !referenceToValues.length) {
            continue;
        }

        const fromToken = relationshipNameToFromToken(relationshipName);

        if (!fromToken) {
            continue;
        }

        const normalizedChild = normalizeObjectApiName(childObjectApiName);

        for (const referenceTo of referenceToValues) {
            const parentObjectApiName = normalizeObjectApiName(referenceTo);

            if (!parentObjectApiName) {
                continue;
            }

            map.set(
                childRelationshipMapKey(parentObjectApiName, fromToken),
                normalizedChild
            );
        }
    }

    return map;
}

module.exports = {
    buildChildRelationshipTargetMap,
    resolveChildRelationshipObject,
    childRelationshipMapKey,
    relationshipNameToFromToken,
    getObjectApiNameFromFieldPath
};
