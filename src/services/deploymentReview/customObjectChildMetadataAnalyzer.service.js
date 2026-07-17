const path = require('path');

const CHILD_METADATA_CONFIG = [
    {
        folder: 'compactLayouts',
        extension: '.compactLayout-meta.xml',
        dependencyType: 'CompactLayout'
    },
    {
        folder: 'fieldSets',
        extension: '.fieldSet-meta.xml',
        dependencyType: 'FieldSet'
    },
    {
        folder: 'listViews',
        extension: '.listView-meta.xml',
        dependencyType: 'ListView'
    },
    {
        folder: 'sharingReasons',
        extension: '.sharingReason-meta.xml',
        dependencyType: 'SharingReason'
    },
    {
        folder: 'webLinks',
        extension: '.webLink-meta.xml',
        dependencyType: 'WebLink'
    },
    {
        folder: 'indexes',
        extension: '.index-meta.xml',
        dependencyType: 'Index'
    }
];

function extractChildApiName(filePath, extension) {
    const baseName = path.posix.basename(String(filePath).replace(/\\/g, '/'));

    if (!baseName.endsWith(extension)) {
        return null;
    }

    return baseName.slice(0, -extension.length);
}

function isChildFileForObject(repoFilePath, objectApiName, folder, extension) {
    const normalizedPath = String(repoFilePath).replace(/\\/g, '/');
    const expectedFolder = `/objects/${objectApiName}/${folder}/`;

    return (
        normalizedPath.includes(expectedFolder) &&
        normalizedPath.endsWith(extension)
    );
}

function scanChildMetadataFolder(
    objectApiName,
    repoFiles,
    folder,
    extension,
    dependencyType
) {
    const requiredDependencies = [];

    if (!objectApiName || !Array.isArray(repoFiles)) {
        return requiredDependencies;
    }

    for (const repoFile of repoFiles) {
        if (!isChildFileForObject(repoFile, objectApiName, folder, extension)) {
            continue;
        }

        const childApiName = extractChildApiName(repoFile, extension);

        if (!childApiName) {
            continue;
        }

        requiredDependencies.push({
            name: `${objectApiName}.${childApiName}`,
            type: dependencyType,
            required: true,
            selected: true,
            editable: false
        });
    }

    return requiredDependencies;
}

function analyzeCustomObjectChildMetadata(objectApiName, repoFiles) {
    if (!objectApiName || !Array.isArray(repoFiles)) {
        return {
            dependencyAnalysis: {
                requiredDependencies: [],
                recommendedTestClasses: [],
                optionalDependencies: []
            }
        };
    }

    const requiredDependencies = [];

    for (const config of CHILD_METADATA_CONFIG) {
        const childDependencies = scanChildMetadataFolder(
            objectApiName,
            repoFiles,
            config.folder,
            config.extension,
            config.dependencyType
        );

        requiredDependencies.push(...childDependencies);
    }

    requiredDependencies.sort((a, b) => a.name.localeCompare(b.name));

    return {
        dependencyAnalysis: {
            requiredDependencies,
            recommendedTestClasses: [],
            optionalDependencies: []
        }
    };
}

module.exports = {
    analyzeCustomObjectChildMetadata,
    scanChildMetadataFolder,
    CHILD_METADATA_CONFIG
};
