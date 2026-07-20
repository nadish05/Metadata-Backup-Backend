/**
 * Metadata reference discoverer registry.
 */

const flexiPageReferenceDiscoverer = require('./discoverers/flexiPageReference.discoverer');

function getRegisteredReferenceDiscoverers() {
    return [flexiPageReferenceDiscoverer];
}

module.exports = {
    getRegisteredReferenceDiscoverers
};
