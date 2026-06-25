async function validateApiVersion(metadataType, filePath, workspace) {
    return {
        supported: true,
        apiVersion: null
    };
}

module.exports = {
    validateApiVersion
};
