'use strict';

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
            normalized.endsWith(`/classes/${metadataName}.cls`))
    );
}

/**
 * @param {Array<{ metadataType?: string, metadataName?: string, filePath?: string }>} classes
 * @returns {Array<{ metadataName: string, filePath: string }>}
 */
function normalizeApexClassSelections(classes = []) {
    const byName = new Map();

    for (const entry of classes) {
        const metadataType = entry?.metadataType || entry?.type || null;
        const metadataName = entry?.metadataName || entry?.name || null;
        const filePath = entry?.filePath
            ? String(entry.filePath).replace(/\\/g, '/')
            : null;

        if (metadataType && metadataType !== 'ApexClass') {
            continue;
        }

        let name = metadataName;

        if (!name && filePath) {
            const match = filePath.match(/\/classes\/([^/]+)\.cls(?:-meta\.xml)?$/);
            name = match ? match[1] : null;
        }

        if (!name) {
            continue;
        }

        const existing = byName.get(name) || {
            metadataName: name,
            filePath: defaultClassPath(name)
        };

        if (filePath && isPrimaryClassPath(filePath, name)) {
            existing.filePath = filePath;
        } else if (filePath && isCompanionMetaPath(filePath, name) && !existing.filePath) {
            existing.filePath = defaultClassPath(name);
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
    isCompanionMetaPath,
    isPrimaryClassPath
};
