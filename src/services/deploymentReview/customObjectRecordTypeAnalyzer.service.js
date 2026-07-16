const path = require('path');

const RECORD_TYPE_META_SUFFIX = '.recordType-meta.xml';

function extractRecordTypeApiName(recordTypeFilePath) {
    const baseName = path.posix.basename(
        String(recordTypeFilePath).replace(/\\/g, '/')
    );

    if (!baseName.endsWith(RECORD_TYPE_META_SUFFIX)) {
        return null;
    }

    return baseName.slice(0, -RECORD_TYPE_META_SUFFIX.length);
}

function isRecordTypeFileForObject(repoFilePath, objectApiName) {
    const normalizedPath = String(repoFilePath).replace(/\\/g, '/');
    const expectedFolder = `/objects/${objectApiName}/recordTypes/`;

    return (
        normalizedPath.includes(expectedFolder) &&
        normalizedPath.endsWith(RECORD_TYPE_META_SUFFIX)
    );
}

function analyzeCustomObjectRecordTypes(objectApiName, repoFiles) {
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
        if (!isRecordTypeFileForObject(repoFile, objectApiName)) {
            continue;
        }

        const recordTypeApiName = extractRecordTypeApiName(repoFile);

        if (!recordTypeApiName) {
            continue;
        }

        requiredDependencies.push({
            name: `${objectApiName}.${recordTypeApiName}`,
            type: 'RecordType',
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
    analyzeCustomObjectRecordTypes,
    extractRecordTypeApiName,
    isRecordTypeFileForObject
};
