/**
 * Relationship discoverer registry.
 * The discovery engine must not contain metadata-type-specific logic.
 */

const customObjectRelationshipDiscoverer = require('./discoverers/customObjectRelationship.discoverer');
const customObjectActionOverrideDiscoverer = require('./discoverers/customObjectActionOverride.discoverer');
const customMetadataParentDiscoverer = require('./discoverers/customMetadataParent.discoverer');
const permissionSetRelationshipDiscoverer = require('./discoverers/permissionSetRelationship.discoverer');
const profileRelationshipDiscoverer = require('./discoverers/profileRelationship.discoverer');
const recordTypeBusinessProcessDiscoverer = require('./discoverers/recordTypeBusinessProcess.discoverer');
const recordTypeCompactLayoutDiscoverer = require('./discoverers/recordTypeCompactLayout.discoverer');
const standardValueSetDiscoverer = require('./discoverers/standardValueSet.discoverer');

function getRegisteredDiscoverers() {
    return [
        customObjectRelationshipDiscoverer,
        customObjectActionOverrideDiscoverer,
        customMetadataParentDiscoverer,
        permissionSetRelationshipDiscoverer,
        profileRelationshipDiscoverer,
        recordTypeBusinessProcessDiscoverer,
        recordTypeCompactLayoutDiscoverer,
        standardValueSetDiscoverer
    ];
}

module.exports = {
    getRegisteredDiscoverers
};
