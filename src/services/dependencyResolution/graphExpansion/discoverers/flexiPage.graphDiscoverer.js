/**
 * FlexiPage graph discoverer.
 * Reuses existing FlexiPage XML reference discoverer — does not duplicate parsing.
 */

const flexiPageReferenceDiscoverer = require('../../discoverers/flexiPageReference.discoverer');
const {
    createEmptyDiscoveryResult,
    createGraphNode,
    createGraphEdge
} = require('../discoveryContract');
const { METADATA_ORIGINS } = require('../../metadataGraphOrigin.model');

const DISCOVERER_ID = 'FlexiPageGraphDiscoverer';
const ACTION_OVERRIDE_RELATIONSHIP = 'ActionOverride';
const ACTION_OVERRIDE_DISCOVERY_METHOD = 'actionOverrides';

function isStructuralActionOverrideFlexiPage(metadata) {
    return (
        metadata?.origin === METADATA_ORIGINS.DIRECT_DEPENDENCY &&
        metadata?.relationship === ACTION_OVERRIDE_RELATIONSHIP &&
        metadata?.discoveryMethod === ACTION_OVERRIDE_DISCOVERY_METHOD
    );
}

const flexiPageGraphDiscoverer = {
    id: DISCOVERER_ID,
    metadataTypes: ['FlexiPage'],

    async discover({ metadata, repoFiles, readRepoFile, depth = 1 }) {
        const result = createEmptyDiscoveryResult({
            metadataScanned: 0,
            filesScanned: 0
        });

        const name = metadata?.name || metadata?.metadataName;

        if (!name) {
            result.warnings.push('FlexiPage discoverer received metadata without a name.');
            return result;
        }

        // Secondary CustomObject actionOverride FlexiPages are already present in
        // the graph from structural discovery. Do not re-expand them into fields,
        // LWCs, or Apex unless they are PRIMARY or PRIMARY CustomObject paths.
        if (isStructuralActionOverrideFlexiPage(metadata)) {
            return result;
        }

        try {
            const discovery = await flexiPageReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: name,
                        name,
                        filePath: metadata.filePath || null,
                        depth
                    }
                ],
                repoFiles,
                readRepoFile,
                depth
            });

            result.statistics.metadataScanned = discovery.metadataScanned || 0;
            result.statistics.filesScanned = discovery.filesScanned || 0;
            result.warnings.push(...(discovery.warnings || []));

            for (const reference of discovery.references || []) {
                const node = createGraphNode({
                    name: reference.name,
                    metadataType: reference.metadataType,
                    deployable: reference.deployable === true,
                    blocking: reference.blocking === true,
                    sourceMetadata: name,
                    discoveredBy: reference.discoveredBy || DISCOVERER_ID,
                    discoveryMethod:
                        reference.discoveryMethod || 'flexiPageReference',
                    referenceType: reference.referenceType || null,
                    reason: reference.reason,
                    depth: reference.depth != null ? reference.depth : depth + 1
                });

                result.discoveredNodes.push(node);
                result.discoveredEdges.push(
                    createGraphEdge({
                        fromType: 'FlexiPage',
                        fromName: name,
                        toType: reference.metadataType,
                        toName: reference.name,
                        relationship: reference.referenceType || 'Reference',
                        discoveredBy: DISCOVERER_ID,
                        reason: reference.reason
                    })
                );
            }
        } catch (error) {
            result.warnings.push(
                `FlexiPage discovery failed for ${name}: ${
                    error?.message || 'unknown error'
                }`
            );
        }

        return result;
    }
};

module.exports = flexiPageGraphDiscoverer;
module.exports.isStructuralActionOverrideFlexiPage =
    isStructuralActionOverrideFlexiPage;
