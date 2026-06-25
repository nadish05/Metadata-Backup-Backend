async function validateCoverage(metadataType, filePath, workspace) {
    return {
        coverage: 0,
        passed: false
    };
}

module.exports = {
    validateCoverage
};
