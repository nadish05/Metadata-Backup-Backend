/**
 * Stable unique identifiers for dependency graph nodes.
 * Format: MetadataType:Name
 * Examples:
 *   CustomObject:Connected_Org__c
 *   CustomField:Connected_Org__c.Display_Name__c
 *   FlexiPage:Connected_Org_Record_Page
 */
function buildGraphNodeId(metadataType, name) {
    if (!metadataType || !name) {
        return null;
    }

    return `${metadataType}:${name}`;
}

function parseGraphNodeId(nodeId) {
    if (!nodeId || typeof nodeId !== 'string') {
        return null;
    }

    const separatorIndex = nodeId.indexOf(':');

    if (separatorIndex <= 0) {
        return null;
    }

    return {
        metadataType: nodeId.slice(0, separatorIndex),
        name: nodeId.slice(separatorIndex + 1)
    };
}

module.exports = {
    buildGraphNodeId,
    parseGraphNodeId
};
