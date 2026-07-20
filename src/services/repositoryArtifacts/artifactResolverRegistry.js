/**
 * Artifact resolver registry.
 * Routes metadata types to type-specific repository path resolvers.
 */

const customObjectResolver = require('./resolvers/customObject.resolver');
const customFieldResolver = require('./resolvers/customField.resolver');
const flexiPageResolver = require('./resolvers/flexiPage.resolver');
const lightningComponentBundleResolver = require('./resolvers/lightningComponentBundle.resolver');
const apexClassResolver = require('./resolvers/apexClass.resolver');
const listViewResolver = require('./resolvers/listView.resolver');
const genericFileResolver = require('./resolvers/genericFile.resolver');

function getRegisteredArtifactResolvers() {
    return [
        customObjectResolver,
        customFieldResolver,
        flexiPageResolver,
        lightningComponentBundleResolver,
        apexClassResolver,
        listViewResolver,
        // Fallback for other FILE metadata types already in METADATA_TYPE_RULES.
        genericFileResolver
    ];
}

function getArtifactResolver(metadataType) {
    if (!metadataType) {
        return null;
    }

    const resolvers = getRegisteredArtifactResolvers();

    return (
        resolvers.find(
            (resolver) =>
                Array.isArray(resolver.metadataTypes) &&
                resolver.metadataTypes.includes(metadataType)
        ) ||
        resolvers.find((resolver) => resolver.applies?.(metadataType)) ||
        null
    );
}

module.exports = {
    getRegisteredArtifactResolvers,
    getArtifactResolver
};
