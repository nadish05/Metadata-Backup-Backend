async function findTestClasses(metadataType, filePath, repoUrl, branch) {
    return {
        found: false,
        testClasses: []
    };
}

module.exports = {
    findTestClasses
};
