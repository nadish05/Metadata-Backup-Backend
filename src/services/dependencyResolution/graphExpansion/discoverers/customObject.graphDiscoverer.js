/**
 * CustomObject graph discoverer.
 * Reuses existing relationship discoverers and Deployment Review for child metadata.
 */

const { getRegisteredDiscoverers } = require('../../relationshipRegistry');
const deploymentReviewService = require('../../../deploymentReview.service');
const {
    createEmptyDiscoveryResult,
    createGraphNode,
    createGraphEdge
} = require('../discoveryContract');

const DISCOVERER_ID = 'CustomObjectGraphDiscoverer';

const customObjectGraphDiscoverer = {
    id: DISCOVERER_ID,
    metadataTypes: ['CustomObject'],

    async discover({
        metadata,
        repoFiles,
        readRepoFile,
        listRepoFiles,
        depth = 1
    }) {
        const result = createEmptyDiscoveryResult({
            metadataScanned: 0,
            filesScanned: 0,
            reviewsExecuted: 0
        });

        const objectName = metadata?.name || metadata?.metadataName;

        if (!objectName) {
            result.warnings.push(
                'CustomObject discoverer received metadata without a name.'
            );
            return result;
        }

        const scanTarget = {
            metadataType: 'CustomObject',
            metadataName: objectName,
            name: objectName,
            filePath: metadata.filePath || null,
            depth
        };

        const seen = new Set();

        function addNode(node, edge) {
            const key = `${node.metadataType}:${node.name}`;

            if (seen.has(key)) {
                return;
            }

            seen.add(key);
            result.discoveredNodes.push(node);

            if (edge) {
                result.discoveredEdges.push(edge);
            }
        }

        try {
            const relationshipDiscoverers = getRegisteredDiscoverers();

            for (const discoverer of relationshipDiscoverers) {
                const discovery = await discoverer.discover({
                    selectedMetadata: [scanTarget],
                    repoFiles,
                    readRepoFile,
                    depth
                });

                result.statistics.metadataScanned +=
                    discovery.metadataScanned || 0;
                result.statistics.filesScanned += discovery.filesScanned || 0;
                result.warnings.push(...(discovery.warnings || []));

                for (const relationship of discovery.relationships || []) {
                    const node = createGraphNode({
                        name: relationship.name,
                        metadataType:
                            relationship.metadataType ||
                            relationship.type ||
                            'CustomObject',
                        deployable: true,
                        blocking: relationship.required !== false,
                        sourceMetadata: objectName,
                        discoveredBy:
                            relationship.discoveredBy || DISCOVERER_ID,
                        discoveryMethod:
                            relationship.discoveryMethod || 'relationship',
                        referenceType: relationship.relationship || null,
                        relationship: relationship.relationship || null,
                        reason: relationship.reason,
                        depth:
                            relationship.depth != null
                                ? relationship.depth
                                : depth + 1
                    });

                    addNode(
                        node,
                        createGraphEdge({
                            fromType: 'CustomObject',
                            fromName: objectName,
                            toType: node.metadataType,
                            toName: node.name,
                            relationship:
                                relationship.relationship || 'RelatedObject',
                            discoveredBy: DISCOVERER_ID,
                            reason: relationship.reason
                        })
                    );
                }
            }
        } catch (error) {
            result.warnings.push(
                `CustomObject relationship discovery failed for ${objectName}: ${
                    error?.message || 'unknown error'
                }`
            );
        }

        try {
            const reviewResult =
                await deploymentReviewService.reviewDeployableMetadataItems({
                    items: [scanTarget],
                    readRepoFile,
                    listRepoFiles
                });

            result.statistics.reviewsExecuted =
                reviewResult.reviewsExecuted || 0;
            result.warnings.push(...(reviewResult.warnings || []));

            for (const dependency of reviewResult.requiredDependencies || []) {
                if (!dependency?.name || !dependency?.type) {
                    continue;
                }

                const node = createGraphNode({
                    name: dependency.name,
                    metadataType: dependency.type,
                    deployable: dependency.required !== false,
                    blocking: dependency.required !== false,
                    sourceMetadata: objectName,
                    discoveredBy: dependency.discoveredBy || DISCOVERER_ID,
                    discoveryMethod:
                        dependency.discoveryMethod || 'deploymentReview',
                    referenceType: dependency.relationship || 'ObjectChild',
                    relationship: dependency.relationship || null,
                    reason:
                        dependency.reason ||
                        `Discovered by Deployment Review of CustomObject ${objectName}.`,
                    depth: depth + 1
                });

                addNode(
                    node,
                    createGraphEdge({
                        fromType: 'CustomObject',
                        fromName: objectName,
                        toType: dependency.type,
                        toName: dependency.name,
                        relationship:
                            dependency.relationship || 'ObjectChild',
                        discoveredBy: DISCOVERER_ID,
                        reason: node.reason
                    })
                );
            }
        } catch (error) {
            result.warnings.push(
                `CustomObject Deployment Review failed for ${objectName}: ${
                    error?.message || 'unknown error'
                }`
            );
        }

        return result;
    }
};

module.exports = customObjectGraphDiscoverer;
