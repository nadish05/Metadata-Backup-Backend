async function validateApiVersion(metadataType, filePath, repoUrl, branch) {
    return {
        supported: true,
        apiVersion: null
    };
}

module.exports = {
    validateApiVersion
};
