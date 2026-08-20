/**
 * Resolve SOQL Relationship__r → lookup/MD field metadata → referenceTo
 * for Apex dependency discovery. Additive fallback when the relationship
 * name is not a strong CustomObject in the analysis unit.
 */

const FIELD_META_SUFFIX = '.field-meta.xml';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function basenameWithoutSuffix(filePath, suffix) {
    const normalized = normalizePath(filePath);
    const base = normalized.split('/').pop() || '';

    if (!base.endsWith(suffix)) {
        return null;
    }

    return base.slice(0, -suffix.length);
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

/**
 * Locate objects/{Object}/fields/{Field}.field-meta.xml in a repo file list.
 */
function resolveFieldMetaFilePath(repoFiles, objectApiName, fieldApiName) {
    if (!objectApiName || !fieldApiName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedFolder = `/objects/${objectApiName}/fields/`;

    return (
        repoFiles
            .map(normalizePath)
            .find(
                (repoFile) =>
                    repoFile.endsWith(FIELD_META_SUFFIX) &&
                    repoFile.includes(expectedFolder) &&
                    basenameWithoutSuffix(repoFile, FIELD_META_SUFFIX) ===
                        fieldApiName
            ) || null
    );
}

/**
 * Read Lookup / MasterDetail <referenceTo> values (custom or standard).
 * Returns [] when type is not a relationship or referenceTo is absent.
 */
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

/**
 * Map key for FROM object + lookup field API name.
 */
function lookupTargetMapKey(fromObjectApiName, lookupFieldApiName) {
    return `${fromObjectApiName}.${lookupFieldApiName}`;
}

/**
 * Collect SOQL FROM + Relationship__r pairs that may need metadata resolution.
 * Does not invent targets — only identifies lookup field candidates on FROM.
 *
 * @param {string} cleanedContent
 * @returns {{ fromObjectApiName: string, lookupFieldApiName: string }[]}
 */
function collectSoqlRelationshipLookupFields(cleanedContent) {
    const pairs = [];
    const seen = new Set();
    const soqlBlocks = String(cleanedContent || '').matchAll(/\[([\s\S]*?)\]/g);

    for (const block of soqlBlocks) {
        const query = block[1];

        if (!/\bSELECT\b/i.test(query) || !/\bFROM\b/i.test(query)) {
            continue;
        }

        const fromMatch = query.match(/\bFROM\s+([A-Za-z][A-Za-z0-9_]*)\b/i);

        if (!fromMatch) {
            continue;
        }

        const fromObjectApiName = fromMatch[1];
        const selectMatch = query.match(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i);

        if (!selectMatch) {
            continue;
        }

        for (const match of selectMatch[1].matchAll(
            /\b([A-Za-z0-9_]+__r)\.([A-Za-z0-9_]+__c)\b/g
        )) {
            const relationshipName = match[1];
            const lookupFieldApiName = relationshipName.replace(
                /__r$/i,
                '__c'
            );
            const key = lookupTargetMapKey(
                fromObjectApiName,
                lookupFieldApiName
            );

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            pairs.push({
                fromObjectApiName,
                lookupFieldApiName
            });
        }
    }

    return pairs;
}

/**
 * Build Map<"FromObject.LookupField__c", string[]> of referenceTo targets
 * from repository field metadata.
 *
 * @param {{
 *   cleanedContent: string,
 *   repoFiles: string[],
 *   readRepoFile: (path: string) => Promise<string>,
 *   normalizeObjectApiName?: (name: string) => string
 * }} options
 * @returns {Promise<Map<string, string[]>>}
 */
async function buildLookupReferenceTargetMap({
    cleanedContent,
    repoFiles,
    readRepoFile,
    normalizeObjectApiName = (name) => name
}) {
    const map = new Map();
    const pairs = collectSoqlRelationshipLookupFields(cleanedContent);

    for (const pair of pairs) {
        const fromObjectApiName = normalizeObjectApiName(
            pair.fromObjectApiName
        );
        const lookupFieldApiName = pair.lookupFieldApiName;
        const fieldPath = resolveFieldMetaFilePath(
            repoFiles,
            fromObjectApiName,
            lookupFieldApiName
        );

        if (!fieldPath) {
            continue;
        }

        let fieldXml;

        try {
            fieldXml = await readRepoFile(fieldPath);
        } catch (_error) {
            continue;
        }

        const referenceToValues =
            extractLookupOrMasterDetailReferenceTo(fieldXml);

        if (!referenceToValues.length) {
            continue;
        }

        map.set(
            lookupTargetMapKey(fromObjectApiName, lookupFieldApiName),
            referenceToValues
        );
    }

    return map;
}

/**
 * Resolve targets for a FROM object + lookup field from a prebuilt map.
 * Tries normalized and raw FROM object keys.
 */
function resolveLookupReferenceTargets(
    lookupReferenceTargets,
    fromObjectApiName,
    lookupFieldApiName
) {
    if (!(lookupReferenceTargets instanceof Map)) {
        return [];
    }

    const keys = [
        lookupTargetMapKey(fromObjectApiName, lookupFieldApiName),
        lookupTargetMapKey(
            String(fromObjectApiName || ''),
            String(lookupFieldApiName || '')
        )
    ];

    for (const key of keys) {
        const values = lookupReferenceTargets.get(key);

        if (Array.isArray(values) && values.length) {
            return values;
        }
    }

    // Case-insensitive fallback for DX folder vs Apex casing drift.
    const wanted = lookupTargetMapKey(
        fromObjectApiName,
        lookupFieldApiName
    ).toLowerCase();

    for (const [key, values] of lookupReferenceTargets.entries()) {
        if (
            String(key).toLowerCase() === wanted &&
            Array.isArray(values) &&
            values.length
        ) {
            return values;
        }
    }

    return [];
}

module.exports = {
    resolveFieldMetaFilePath,
    extractLookupOrMasterDetailReferenceTo,
    collectSoqlRelationshipLookupFields,
    buildLookupReferenceTargetMap,
    resolveLookupReferenceTargets,
    lookupTargetMapKey
};
