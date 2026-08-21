/**
 * Discover parent Custom Metadata Type (CustomObject:Type__mdt) from
 * CustomMetadata records named Type.Record.
 *
 * Uses the shared CustomMetadata member parser so name validation matches
 * destination existence / SOQL handling. Does not invent CustomMetadataType.
 */

const {
    parseCustomMetadataMember
} = require('../../destinationInventory/destinationExistenceQueries');

const DISCOVERER_ID = 'CustomMetadataParentDiscoverer';
const DISCOVERY_METHOD = 'customMetadataParent';
const RELATIONSHIP = 'CustomMetadataParentType';

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

/**
 * Derive parent CustomObject API name (Type__mdt) from a CustomMetadata member.
 * Returns null for malformed names (bare type, trailing/leading dots, multi-dot).
 *
 * @param {string} name
 * @returns {string|null}
 */
function deriveCustomMetadataParentObjectName(name) {
    return parseCustomMetadataMember(name)?.entityApiName || null;
}

function createParentCustomObjectRelationship({
    parentObjectName,
    sourceCustomMetadataName,
    depth
}) {
    return {
        name: parentObjectName,
        metadataType: 'CustomObject',
        type: 'CustomObject',
        relationship: RELATIONSHIP,
        sourceMetadata: sourceCustomMetadataName,
        sourceField: null,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        filePath: null,
        reason: `Custom Metadata Type ${parentObjectName} is required by CustomMetadata record ${sourceCustomMetadataName}.`
    };
}

/**
 * Discover CustomObject:Type__mdt parents for selected CustomMetadata:Type.Record.
 */
const customMetadataParentDiscoverer = {
    id: DISCOVERER_ID,
    deriveCustomMetadataParentObjectName,

    async discover({ selectedMetadata, depth = 1 }) {
        const relationships = [];
        const warnings = [];
        const seen = new Set();
        let metadataScanned = 0;
        const filesScanned = 0;

        if (!Array.isArray(selectedMetadata)) {
            return {
                relationships,
                warnings,
                filesScanned,
                metadataScanned
            };
        }

        for (const item of selectedMetadata) {
            if (getItemType(item) !== 'CustomMetadata') {
                continue;
            }

            metadataScanned += 1;

            const memberName = getItemName(item);

            if (!memberName) {
                continue;
            }

            const parentObjectName =
                deriveCustomMetadataParentObjectName(memberName);

            if (!parentObjectName) {
                continue;
            }

            const key = `CustomObject:${parentObjectName}`;

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            relationships.push(
                createParentCustomObjectRelationship({
                    parentObjectName,
                    sourceCustomMetadataName: memberName,
                    depth
                })
            );
        }

        return {
            relationships,
            warnings,
            filesScanned,
            metadataScanned
        };
    }
};

module.exports = customMetadataParentDiscoverer;
