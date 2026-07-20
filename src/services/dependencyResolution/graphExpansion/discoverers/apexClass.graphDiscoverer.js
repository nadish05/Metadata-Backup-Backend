/**
 * ApexClass graph discoverer.
 * Delegates to existing Deployment Review — single source of truth for Apex deps.
 */

const deploymentReviewService = require('../../../deploymentReview.service');
const {
    createEmptyDiscoveryResult,
    createGraphNode,
    createGraphEdge
} = require('../discoveryContract');

const DISCOVERER_ID = 'ApexClassGraphDiscoverer';

const apexClassGraphDiscoverer = {
    id: DISCOVERER_ID,
    metadataTypes: ['ApexClass'],

    async discover({
        metadata,
        readRepoFile,
        listRepoFiles,
        depth = 1
    }) {
        const result = createEmptyDiscoveryResult({
            metadataScanned: 0,
            filesScanned: 0,
            reviewsExecuted: 0
        });

        const className = metadata?.name || metadata?.metadataName;

        if (!className) {
            result.warnings.push(
                'ApexClass discoverer received metadata without a name.'
            );
            return result;
        }

        try {
            const reviewResult =
                await deploymentReviewService.reviewDeployableMetadataItems({
                    items: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: className,
                            name: className,
                            filePath: metadata.filePath || null
                        }
                    ],
                    readRepoFile,
                    listRepoFiles
                });

            result.statistics.metadataScanned = 1;
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
                    sourceMetadata: className,
                    discoveredBy: dependency.discoveredBy || DISCOVERER_ID,
                    discoveryMethod:
                        dependency.discoveryMethod || 'deploymentReview',
                    referenceType: dependency.relationship || 'ApexDependency',
                    relationship: dependency.relationship || null,
                    reason:
                        dependency.reason ||
                        `Discovered by Deployment Review of ApexClass ${className}.`,
                    depth: depth + 1
                });

                result.discoveredNodes.push(node);
                result.discoveredEdges.push(
                    createGraphEdge({
                        fromType: 'ApexClass',
                        fromName: className,
                        toType: dependency.type,
                        toName: dependency.name,
                        relationship:
                            dependency.relationship || 'ApexDependency',
                        discoveredBy: DISCOVERER_ID,
                        reason: node.reason
                    })
                );
            }
        } catch (error) {
            result.warnings.push(
                `ApexClass discovery failed for ${className}: ${
                    error?.message || 'unknown error'
                }`
            );
        }

        return result;
    }
};

module.exports = apexClassGraphDiscoverer;
