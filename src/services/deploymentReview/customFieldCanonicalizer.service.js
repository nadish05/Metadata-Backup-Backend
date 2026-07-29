/**
 * CustomField name canonicalizer.
 *
 * Apex is case-insensitive; metadata API / DX file names are case-sensitive.
 * This stage rewrites CustomField identities to match repository field filenames
 * when exactly one case-insensitive match exists.
 *
 * Does not alter dependency discovery. Does not touch Artifact Resolution.
 */

const FIELD_META_SUFFIX = '.field-meta.xml';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function listFieldApiNamesForObject(objectApiName, repoFiles) {
    if (!objectApiName || !Array.isArray(repoFiles)) {
        return [];
    }

    const expectedFolder = `/objects/${objectApiName}/fields/`;
    const names = [];

    for (const repoFile of repoFiles) {
        const normalized = normalizePath(repoFile);

        if (
            !normalized.includes(expectedFolder) ||
            !normalized.endsWith(FIELD_META_SUFFIX)
        ) {
            continue;
        }

        const baseName = normalized.split('/').pop() || '';
        const fieldApiName = baseName.slice(0, -FIELD_META_SUFFIX.length);

        if (fieldApiName) {
            names.push(fieldApiName);
        }
    }

    return names;
}

/**
 * Canonicalize a CustomField identity Object__c.Field__c against repo files.
 * Only the field segment may change. Object segment is preserved.
 *
 * @param {string} metadataName
 * @param {string[]} repoFiles
 * @returns {string}
 */
function canonicalizeCustomFieldName(metadataName, repoFiles) {
    if (!metadataName || typeof metadataName !== 'string') {
        return metadataName;
    }

    if (!metadataName.includes('.')) {
        return metadataName;
    }

    const [objectApiName, fieldApiName] = metadataName.split('.');

    if (!objectApiName || !fieldApiName) {
        return metadataName;
    }

    const fieldNames = listFieldApiNamesForObject(objectApiName, repoFiles);
    const needle = fieldApiName.toLowerCase();
    const matches = fieldNames.filter(
        (name) => String(name).toLowerCase() === needle
    );

    if (matches.length !== 1) {
        return metadataName;
    }

    return `${objectApiName}.${matches[0]}`;
}

/**
 * Canonicalize CustomField entries in a requiredDependencies-style list.
 * Non-CustomField rows are returned unchanged.
 *
 * @param {Array<object>} dependencies
 * @param {string[]} repoFiles
 * @returns {Array<object>}
 */
function canonicalizeCustomFieldDependencies(dependencies, repoFiles) {
    if (!Array.isArray(dependencies)) {
        return [];
    }

    return dependencies.map((dependency) => {
        if (!dependency || typeof dependency !== 'object') {
            return dependency;
        }

        const metadataType = dependency.type || dependency.metadataType;

        if (metadataType !== 'CustomField') {
            return dependency;
        }

        const originalName = dependency.name || dependency.metadataName || null;
        const canonicalName = canonicalizeCustomFieldName(
            originalName,
            repoFiles
        );

        if (!canonicalName || canonicalName === originalName) {
            return dependency;
        }

        const next = {
            ...dependency,
            name: canonicalName
        };

        if (dependency.metadataName != null) {
            next.metadataName = canonicalName;
        }

        return next;
    });
}

module.exports = {
    canonicalizeCustomFieldName,
    canonicalizeCustomFieldDependencies,
    listFieldApiNamesForObject
};
