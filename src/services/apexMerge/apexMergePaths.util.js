'use strict';

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');

/**
 * Normalize planner/compare rows into one logical Apex class per metadataName.
 */

function defaultClassPath(metadataName) {
    return `force-app/main/default/classes/${metadataName}.cls`;
}

function companionMetaPath(clsPath) {
    return `${clsPath}-meta.xml`;
}

function isCompanionMetaPath(filePath, metadataName) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    const cls = defaultClassPath(metadataName);
    return (
        normalized.endsWith('.cls-meta.xml') &&
        (normalized === companionMetaPath(cls) ||
            normalized.includes(`/classes/${metadataName}.cls-meta.xml`))
    );
}

function isPrimaryClassPath(filePath, metadataName) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    return (
        normalized.endsWith('.cls') &&
        !normalized.endsWith('.cls-meta.xml') &&
        (normalized === defaultClassPath(metadataName) ||
            normalized.endsWith(`/classes/${metadataName}.cls`) ||
            normalized.endsWith(`/${metadataName}.cls`))
    );
}

function resolveClassFilePath(entry) {
    const pathCandidate = entry?.filePath || entry?.classFilePath;
    return pathCandidate ? String(pathCandidate).replace(/\\/g, '/') : null;
}

/**
 * Accept `classes` or `eligibleClasses` from create payload.
 * @param {object} body
 * @returns {Array<object>}
 */
function coalesceClassSelectionInput(body = {}) {
    const primary = body.classes;
    const alternate = body.eligibleClasses;

    if (Array.isArray(primary) && primary.length) {
        return primary;
    }

    if (Array.isArray(alternate) && alternate.length) {
        return alternate;
    }

    if (Array.isArray(primary)) {
        return primary;
    }

    if (Array.isArray(alternate)) {
        return alternate;
    }

    return [];
}

/**
 * @param {Array<{ metadataType?: string, metadataName?: string, filePath?: string, classFilePath?: string }>} classes
 * @returns {Array<{ metadataName: string, filePath: string }>}
 */
function normalizeApexClassSelections(classes = []) {
    const byName = new Map();

    for (const entry of classes) {
        const metadataType = entry?.metadataType || entry?.type || null;
        const metadataName = entry?.metadataName || entry?.name || null;
        const filePath = resolveClassFilePath(entry);

        if (metadataType && metadataType !== 'ApexClass') {
            continue;
        }

        let name = metadataName;

        if (!name && filePath) {
            const match = filePath.match(/\/([^/]+)\.cls(?:-meta\.xml)?$/i);
            name = match ? match[1] : null;
        }

        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            if (filePath || metadataName) {
                throw new ApexMergeError(
                    MERGE_ERROR.MALFORMED_CLASS_SELECTION,
                    'Apex class selection is missing a valid metadataName.',
                    { metadataName, filePath }
                );
            }
            continue;
        }

        if (
            filePath &&
            /\.cls$/i.test(filePath) &&
            !filePath.toLowerCase().endsWith('.cls-meta.xml') &&
            !isPrimaryClassPath(filePath, name)
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.MALFORMED_CLASS_SELECTION,
                `filePath does not match metadataName ${name}.`,
                { metadataName: name, filePath }
            );
        }

        const existing = byName.get(name);

        if (!existing) {
            byName.set(name, {
                metadataName: name,
                filePath:
                    filePath && isPrimaryClassPath(filePath, name)
                        ? filePath
                        : defaultClassPath(name)
            });
            continue;
        }

        if (filePath && isPrimaryClassPath(filePath, name)) {
            if (existing.filePath !== filePath) {
                throw new ApexMergeError(
                    MERGE_ERROR.DUPLICATE_CLASS_IDENTITY,
                    `Conflicting file paths for ApexClass ${name}.`,
                    {
                        metadataName: name,
                        existingFilePath: existing.filePath,
                        incomingFilePath: filePath
                    }
                );
            }
        } else if (filePath && isCompanionMetaPath(filePath, name)) {
            byName.set(name, existing);
            continue;
        }

        byName.set(name, existing);
    }

    return [...byName.values()].sort((a, b) =>
        a.metadataName.localeCompare(b.metadataName)
    );
}

module.exports = {
    defaultClassPath,
    companionMetaPath,
    normalizeApexClassSelections,
    coalesceClassSelectionInput,
    resolveClassFilePath,
    isCompanionMetaPath,
    isPrimaryClassPath
};
