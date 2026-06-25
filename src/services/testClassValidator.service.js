const path = require('path');

function getClassNameFromFilePath(filePath) {
    return path.basename(filePath, path.extname(filePath));
}

function getClassNameFromContent(content, filePath) {
    const classMatch = content.match(
        /\b(?:public|global|private|with\s+sharing|without\s+sharing|inherited\s+sharing)\s+(?:virtual\s+|abstract\s+)?class\s+([A-Za-z0-9_]+)/
    );

    if (classMatch) {
        return classMatch[1];
    }

    return getClassNameFromFilePath(filePath);
}

function isTestClass(content) {
    return /@isTest\b/i.test(content) || /\bisTest\b/.test(content);
}

function referencesClass(content, className) {
    const classPattern = new RegExp(`\\b${className}\\b`);
    return classPattern.test(content);
}

async function findTestClasses(metadataType, filePath, readRepoFile, listRepoFiles) {
    const targetClassName = getClassNameFromFilePath(filePath);
    const apexClassPaths = (await listRepoFiles()).filter(
        (repoPath) => repoPath.endsWith('.cls')
    );

    const testClasses = [];

    for (const apexClassPath of apexClassPaths) {
        if (apexClassPath === filePath) {
            continue;
        }

        let content;

        try {
            content = await readRepoFile(apexClassPath);
        } catch (error) {
            continue;
        }

        if (!isTestClass(content)) {
            continue;
        }

        if (!referencesClass(content, targetClassName)) {
            continue;
        }

        testClasses.push({
            name: getClassNameFromContent(content, apexClassPath),
            path: apexClassPath
        });
    }

    testClasses.sort((a, b) => a.name.localeCompare(b.name));

    return {
        found: testClasses.length > 0,
        testClasses
    };
}

module.exports = {
    findTestClasses
};
