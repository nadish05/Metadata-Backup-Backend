async function validateCoverage(metadataType, filePath, repoUrl, branch) {
    return {
        coverage: 0,
        passed: false
    };
}

module.exports = {
    validateCoverage
};
