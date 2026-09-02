const {
    classifyDependency
} = require('../dependencyResolution/dependencyClassification.service');

/**
 * Collect metadata participating in Destination Inventory.
 *
 * Unions selected metadata, resolved/enriched dependencies, discovered
 * references, and optional bounded closure-prerequisite candidates into
 * one deduplicated candidate list for a single batched inventory pass.
 *
 * Does not query Salesforce or affect Deploy/Skip decisions.
 *
 * @param {object} options
 * @param {Array<object>} [options.selectedMetadata]
 * @param {Array<object>} [options.requiredDependencies]
 * @param {Array<object>} [options.discoveredReferences]
 * @param {Array<object>} [options.closureCandidates] Bounded deployable
 *   prerequisites supplied explicitly (not full graph enumeration).
 * @returns {Array<{ metadataType: string, metadataName: string }>}
 */
function collectDestinationInventoryItems({
    selectedMetadata,
    requiredDependencies,
    discoveredReferences,
    closureCandidates = []
} = {}) {
    const byKey = new Map();

    const addItem = (metadataType, metadataName) => {
        if (!metadataType || !metadataName) {
            return;
        }

        const key = `${metadataType}:${metadataName}`;

        if (!byKey.has(key)) {
            byKey.set(key, { metadataType, metadataName });
        }
    };

    for (const item of selectedMetadata || []) {
        addItem(
            item?.metadataType || item?.type,
            item?.metadataName || item?.name
        );
    }

    for (const item of requiredDependencies || []) {
        addItem(
            item?.metadataType || item?.type,
            item?.metadataName || item?.name
        );
    }

    for (const item of discoveredReferences || []) {
        addItem(
            item?.metadataType || item?.type,
            item?.metadataName || item?.name
        );
    }

    for (const item of closureCandidates || []) {
        if (item?.deployable === false) {
            continue;
        }

        const metadataType = item?.metadataType || item?.type;
        const metadataName = item?.metadataName || item?.name;

        if (!metadataType || !metadataName) {
            continue;
        }

        const classification = classifyDependency({
            metadataType,
            metadataName,
            type: metadataType,
            name: metadataName,
            deployable: item?.deployable
        });

        if (classification.packageable !== true) {
            continue;
        }

        addItem(metadataType, metadataName);
    }

    return [...byKey.values()];
}

module.exports = {
    collectDestinationInventoryItems
};
