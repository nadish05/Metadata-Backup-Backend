/**
 * Metadata reference discoverer registry.
 */

const flexiPageReferenceDiscoverer = require('./discoverers/flexiPageReference.discoverer');
const layoutReferenceDiscoverer = require('./discoverers/layoutReference.discoverer');

function getRegisteredReferenceDiscoverers() {
    return [flexiPageReferenceDiscoverer, layoutReferenceDiscoverer];
}

module.exports = {
    getRegisteredReferenceDiscoverers
};
