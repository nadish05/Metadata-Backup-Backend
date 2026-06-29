const path = require('path');

function extractApexClassName(name, filePath) {
    if (filePath) {
        const baseName = path.basename(filePath, path.extname(filePath));
        if (baseName) {
            return baseName;
        }
    }

    if (!name) {
        return null;
    }

    if (name.endsWith('.cls')) {
        return path.basename(name, '.cls');
    }

    return name;
}

function normalizeMetadataItem(item) {
    if (typeof item === 'string') {
        if (item.endsWith('.cls')) {
            return {
                name: item,
                type: 'ApexClass',
                path: null,
                apexClassName: extractApexClassName(item, null)
            };
        }

        return {
            name: item,
            type: null,
            path: null,
            apexClassName: null
        };
    }

    const name = item?.name || null;
    const type = item?.type || null;
    const filePath = item?.path || null;
    const isApexClass =
        type === 'ApexClass' ||
        name?.endsWith('.cls') ||
        (filePath?.includes('/classes/') && filePath?.endsWith('.cls'));

    return {
        name: name || filePath || null,
        type: type || (isApexClass ? 'ApexClass' : null),
        path: filePath,
        apexClassName: isApexClass
            ? extractApexClassName(name, filePath)
            : null
    };
}

function resolveSelectedMetadata(deploymentPackage) {
    const selectedMetadata = deploymentPackage?.selectedMetadata;

    if (!Array.isArray(selectedMetadata)) {
        return {
            apexClasses: [],
            ignoredMetadata: []
        };
    }

    const apexClassSet = new Set();
    const ignoredMetadata = [];

    for (const item of selectedMetadata) {
        const normalized = normalizeMetadataItem(item);

        if (!normalized.name && !normalized.path) {
            continue;
        }

        if (normalized.apexClassName) {
            apexClassSet.add(normalized.apexClassName);
            continue;
        }

        ignoredMetadata.push({
            name: normalized.name,
            type: normalized.type || 'Unknown'
        });
    }

    return {
        apexClasses: [...apexClassSet].sort(),
        ignoredMetadata: ignoredMetadata.sort((a, b) =>
            a.name.localeCompare(b.name)
        )
    };
}

module.exports = {
    resolveSelectedMetadata
};
