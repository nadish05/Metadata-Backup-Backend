/**
 * Source dependency extractor registry.
 * Future extractors (labels, static resources, child LWCs, etc.) register here.
 */

const apexImportExtractor = require('./apexImport.extractor');

function getRegisteredExtractors() {
    return [apexImportExtractor];
}

function getExtractorsForMetadataType(metadataType) {
    return getRegisteredExtractors().filter((extractor) => {
        if (!Array.isArray(extractor.metadataTypes) || !extractor.metadataTypes.length) {
            return true;
        }

        return extractor.metadataTypes.includes(metadataType);
    });
}

module.exports = {
    getRegisteredExtractors,
    getExtractorsForMetadataType
};
