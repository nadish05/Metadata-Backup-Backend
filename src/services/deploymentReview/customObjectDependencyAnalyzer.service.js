const path = require('path');

const FIELD_META_SUFFIX = '.field-meta.xml';
const OBJECT_META_SUFFIX = '.object-meta.xml';

function getCustomObjectApiName(filePath) {
    if (!filePath) {
        return null;
    }

    const normalizedPath = String(filePath).replace(/\\/g, '/');
    const baseName = path.posix.basename(normalizedPath);

    if (baseName.endsWith(OBJECT_META_SUFFIX)) {
        return baseName.slice(0, -OBJECT_META_SUFFIX.length);
    }

    const objectsSegment = '/objects/';
    const objectsIndex = normalizedPath.indexOf(objectsSegment);

    if (objectsIndex !== -1) {
        const afterObjects = normalizedPath.slice(
            objectsIndex + objectsSegment.length
        );
        const objectFolderName = afterObjects.split('/')[0];

        if (objectFolderName) {
            return objectFolderName;
        }
    }

    return null;
}

function extractFieldApiName(fieldFilePath) {
    const baseName = path.posix.basename(
        String(fieldFilePath).replace(/\\/g, '/')
    );

    if (!baseName.endsWith(FIELD_META_SUFFIX)) {
        return null;
    }

    return baseName.slice(0, -FIELD_META_SUFFIX.length);
}

function isFieldFileForObject(repoFilePath, objectApiName) {
    const normalizedPath = String(repoFilePath).replace(/\\/g, '/');
    const expectedFolder = `/objects/${objectApiName}/fields/`;

    return (
        normalizedPath.includes(expectedFolder) &&
        normalizedPath.endsWith(FIELD_META_SUFFIX)
    );
}

function analyzeCustomObjectFields(objectApiName, repoFiles) {
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

    for (const repoFile of repoFiles) {
        if (!isFieldFileForObject(repoFile, objectApiName)) {
            continue;
        }

        const fieldApiName = extractFieldApiName(repoFile);

        if (!fieldApiName) {
            continue;
        }

        requiredDependencies.push({
            name: `${objectApiName}.${fieldApiName}`,
            type: 'CustomField',
            required: true,
            selected: true,
            editable: false
        });
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
    analyzeCustomObjectFields,
    getCustomObjectApiName,
    extractFieldApiName
};
