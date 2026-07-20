/**
 * Relationship discoverer registry.
 * The discovery engine must not contain metadata-type-specific logic.
 */

const customObjectRelationshipDiscoverer = require('./discoverers/customObjectRelationship.discoverer');
const customObjectActionOverrideDiscoverer = require('./discoverers/customObjectActionOverride.discoverer');

function getRegisteredDiscoverers() {
    return [
        customObjectRelationshipDiscoverer,
        customObjectActionOverrideDiscoverer
    ];
}

module.exports = {
    getRegisteredDiscoverers
};
