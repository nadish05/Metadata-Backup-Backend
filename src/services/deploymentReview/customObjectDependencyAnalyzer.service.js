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

function analyzeCustomObjectFields(
    objectApiName,
    repoFiles,
    debugContext = null
) {
    // TEMPORARY DEBUG — confirm method entry (remove after trace).
    {
        const stack = new Error().stack || '';
        const topFrames = stack
            .split('\n')
            .slice(1, 6)
            .map((line) => line.trim())
            .join('\n');

        console.log('==========================================================');
        console.log('ENTER analyzeCustomObjectFields()');
        console.log('==========================================================');
        console.log('Object:');
        console.log(objectApiName);
        console.log('Origin:');
        console.log(debugContext?.origin ?? 'n/a');
        console.log('Call Stack (top few frames only)');
        console.log(topFrames || 'n/a');
        console.log('==========================================================');
    }

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

        // TEMPORARY DEBUG — Price__c specifically (remove after trace).
        if (fieldApiName === 'Price__c') {
            console.log('==========================================================');
            console.log('PRICE FIELD ADDED');
            console.log('==========================================================');
            console.log('Object:');
            console.log(objectApiName);
            console.log('Field:');
            console.log(`${objectApiName}.${fieldApiName}`);
            console.log('Origin:');
            console.log(debugContext?.origin ?? 'n/a');
            console.log('Caller:');
            console.log(debugContext?.caller ?? 'n/a');
            console.log('Reason:');
            console.log(
                'Enumerated from object fields folder during CustomObject full review'
            );
            console.log('(Current review strategy)');
            console.log(debugContext?.reviewStrategy ?? 'FULL_OBJECT');
            console.log('==========================================================');
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
