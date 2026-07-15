const path = require('path');

const VALIDATION_RULE_META_SUFFIX = '.validationRule-meta.xml';

function extractValidationRuleApiName(validationRuleFilePath) {
    const baseName = path.posix.basename(
        String(validationRuleFilePath).replace(/\\/g, '/')
    );

    if (!baseName.endsWith(VALIDATION_RULE_META_SUFFIX)) {
        return null;
    }

    return baseName.slice(0, -VALIDATION_RULE_META_SUFFIX.length);
}

function isValidationRuleFileForObject(repoFilePath, objectApiName) {
    const normalizedPath = String(repoFilePath).replace(/\\/g, '/');
    const expectedFolder = `/objects/${objectApiName}/validationRules/`;

    return (
        normalizedPath.includes(expectedFolder) &&
        normalizedPath.endsWith(VALIDATION_RULE_META_SUFFIX)
    );
}

function analyzeCustomObjectValidationRules(objectApiName, repoFiles) {
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
        if (!isValidationRuleFileForObject(repoFile, objectApiName)) {
            continue;
        }

        const validationRuleApiName = extractValidationRuleApiName(repoFile);

        if (!validationRuleApiName) {
            continue;
        }

        requiredDependencies.push({
            name: `${objectApiName}.${validationRuleApiName}`,
            type: 'ValidationRule',
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
    analyzeCustomObjectValidationRules,
    extractValidationRuleApiName,
    isValidationRuleFileForObject
};
