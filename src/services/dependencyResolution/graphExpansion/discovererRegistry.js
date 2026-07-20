/**
 * Metadata-type discoverer registry for graph expansion.
 * Routes discovery by metadata type without embedding type logic in the engine.
 */

const flexiPageGraphDiscoverer = require('./discoverers/flexiPage.graphDiscoverer');
const lightningComponentBundleGraphDiscoverer = require('./discoverers/lightningComponentBundle.graphDiscoverer');
const apexClassGraphDiscoverer = require('./discoverers/apexClass.graphDiscoverer');
const customObjectGraphDiscoverer = require('./discoverers/customObject.graphDiscoverer');

function getRegisteredGraphDiscoverers() {
    return [
        flexiPageGraphDiscoverer,
        lightningComponentBundleGraphDiscoverer,
        apexClassGraphDiscoverer,
        customObjectGraphDiscoverer
    ];
}

function getDiscovererForMetadataType(metadataType) {
    if (!metadataType) {
        return null;
    }

    return (
        getRegisteredGraphDiscoverers().find((discoverer) =>
            (discoverer.metadataTypes || []).includes(metadataType)
        ) || null
    );
}

module.exports = {
    getRegisteredGraphDiscoverers,
    getDiscovererForMetadataType
};
