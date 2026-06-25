async function findTestClasses(metadataType, filePath, workspace) {
    return {
        found: false,
        testClasses: []
    };
}

module.exports = {
    findTestClasses
};
