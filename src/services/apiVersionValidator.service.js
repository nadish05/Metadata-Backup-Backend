function getMetadataXmlPath(filePath) {
    return `${filePath}-meta.xml`;
}

async function validateApiVersion(metadataType, filePath, readRepoFile) {
    const metadataXmlPath = getMetadataXmlPath(filePath);

    try {
        const metadataXml = await readRepoFile(metadataXmlPath);

        const apiVersionMatch = metadataXml.match(
            /<apiVersion>\s*([\d.]+)\s*<\/apiVersion>/i
        );

        if (!apiVersionMatch) {
            return {
                supported: false,
                apiVersion: null
            };
        }

        return {
            supported: true,
            apiVersion: apiVersionMatch[1]
        };
    } catch (error) {
        return {
            supported: false,
            apiVersion: null,
            reason: 'Metadata XML not found'
        };
    }
}

module.exports = {
    validateApiVersion,
    getMetadataXmlPath
};
