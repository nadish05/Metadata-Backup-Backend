/**
 * Relationship discoverer registry.
 * The discovery engine must not contain metadata-type-specific logic.
 */

const customObjectRelationshipDiscoverer = require('./discoverers/customObjectRelationship.discoverer');

function getRegisteredDiscoverers() {
    return [customObjectRelationshipDiscoverer];
}

module.exports = {
    getRegisteredDiscoverers
};
