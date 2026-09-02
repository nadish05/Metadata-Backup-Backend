/**
 * Metadata Graph Expansion Engine.
 *
 * Queue-based recursive expansion that routes each node to a type discoverer.
 * Extends the platform without replacing Relationship Discovery, Reference
 * Discovery, Dependency Resolution, or Deployment Review.
 */

const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const { getDiscovererForMetadataType } = require('./discovererRegistry');
const {
    createEmptyDiscoveryResult,
    getNodeKey,
    getEdgeKey
} = require('./discoveryContract');
const { buildGraphNodeId } = require('../graphId');
const {
    METADATA_ORIGINS
} = require('../metadataGraphOrigin.model');

const execAsync = util.promisify(exec);

const MAX_GRAPH_DEPTH = 10;
const MAX_NODE_COUNT = 1000;

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function toFrontierNode(item, depth = 0) {
    const metadataType = item?.metadataType || item?.type || null;
    const name = item?.metadataName || item?.name || null;

    if (!metadataType || !name) {
        return null;
    }

    const referenceType = item?.referenceType || item?.relationship || null;

    return {
        metadataType,
        type: metadataType,
        name,
        metadataName: name,
        filePath: item.filePath || null,
        depth: item.depth != null ? item.depth : depth,
        deployable: item.deployable !== false,
        blocking: item.blocking !== false,
        origin: item.origin || null,
        referenceType,
        relationship: item?.relationship || referenceType,
        discoveryMethod: item?.discoveryMethod || null,
        sourceMetadata: item?.sourceMetadata || null
    };
}

function collectSeedNodes({
    selectedMetadata,
    discoveredRelationships,
    discoveredReferences,
    enrichedDependencies
}) {
    const seeds = [];
    const seen = new Set();

    // Types that participate in graph-expansion discoverers.
    // CustomObjects from prior Relationship Discovery are not re-seeded;
    // new CustomObjects discovered via Apex Review are enqueued during expansion.
    const relationshipSeedTypes = new Set([
        'FlexiPage',
        'LightningComponentBundle',
        'ApexClass'
    ]);

    function addSeed(item, depth = 0) {
        const node = toFrontierNode(item, depth);
        const key = getNodeKey(node);

        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        seeds.push(node);
    }

    for (const item of selectedMetadata || []) {
        addSeed(
            {
                ...item,
                origin: item.origin || METADATA_ORIGINS.PRIMARY_SELECTION
            },
            0
        );
    }

    for (const item of discoveredRelationships || []) {
        const type = item?.metadataType || item?.type;

        if (relationshipSeedTypes.has(type)) {
            addSeed(
                {
                    ...item,
                    origin:
                        item.origin || METADATA_ORIGINS.RELATIONSHIP_TARGET
                },
                item.depth || 1
            );
        }
    }

    for (const item of discoveredReferences || []) {
        if (item?.deployable === true) {
            addSeed(
                {
                    ...item,
                    origin:
                        item.origin || METADATA_ORIGINS.SECONDARY_DEPENDENCY
                },
                item.depth || 1
            );
        }
    }

    // Prefer selected Apex/LWC/FlexiPage over dumping every enriched CustomObject.
    for (const item of enrichedDependencies || []) {
        const type = item?.type || item?.metadataType;

        if (relationshipSeedTypes.has(type)) {
            addSeed(
                {
                    ...item,
                    origin:
                        item.origin || METADATA_ORIGINS.DIRECT_DEPENDENCY
                },
                item.depth || 1
            );
        }
    }

    return seeds;
}

function nodeToReference(node) {
    return {
        id: buildGraphNodeId(node.metadataType, node.name),
        name: node.name,
        metadataType: node.metadataType,
        type: node.metadataType,
        deployable: node.deployable === true,
        blocking: node.blocking === true,
        required: node.blocking !== false,
        selected: false,
        sourceMetadata: node.sourceMetadata || null,
        discoveredBy: node.discoveredBy || 'GraphExpansion',
        discoveryMethod: node.discoveryMethod || 'graphExpansion',
        referenceType:
            node.referenceType || node.relationship || 'GraphExpansion',
        reason: node.reason || null,
        depth: node.depth || 1,
        filePath: node.filePath || null
    };
}

function nodeToDependency(node) {
    return {
        name: node.name,
        type: node.metadataType,
        metadataType: node.metadataType,
        required: node.blocking !== false,
        selected: true,
        relationship: node.relationship || node.referenceType || null,
        sourceMetadata: node.sourceMetadata || null,
        discoveredBy: node.discoveredBy || 'GraphExpansion',
        discoveryMethod: node.discoveryMethod || 'graphExpansion',
        reason: node.reason || null,
        depth: node.depth || 1,
        filePath: node.filePath || null
    };
}

async function withClonedRepository({ repoUrl, branch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = path.join(
        os.tmpdir(),
        `graph-expansion-${Date.now()}`
    );

    const authenticatedUrl =
        githubToken && repoUrl?.startsWith('https://')
            ? repoUrl.replace('https://', `https://${githubToken}@`)
            : repoUrl;

    try {
        await execAsync(
            `git clone --branch ${shellQuote(branch)} --single-branch ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );

        const readRepoFile = async (targetPath) => {
            const fileContent = await execAsync(
                `cd ${shellQuote(repoPath)} && git show HEAD:${shellQuote(targetPath)}`
            );

            return fileContent.stdout;
        };

        const listRepoFiles = async () => {
            const result = await execAsync(
                `cd ${shellQuote(repoPath)} && git ls-tree -r --name-only HEAD`
            );

            return result.stdout
                .split('\n')
                .map((line) => line.trim().replace(/\\/g, '/'))
                .filter(Boolean);
        };

        return await callback(readRepoFile, listRepoFiles);
    } finally {
        try {
            await execAsync(
                process.platform === 'win32'
                    ? `rmdir /s /q ${shellQuote(repoPath)}`
                    : `rm -rf ${shellQuote(repoPath)}`
            );
        } catch (error) {
            // Cleanup best-effort.
        }
    }
}

/**
 * Expand the metadata graph recursively until stable.
 */
async function expandMetadataGraph({
    selectedMetadata = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    enrichedDependencies = [],
    repoUrl,
    sourceBranch
} = {}) {
    logSection('Metadata Graph Expansion Engine');

    const empty = {
        discoveredNodes: [],
        discoveredEdges: [],
        discoveredReferences: [],
        discoveredDependencies: [],
        warnings: [],
        summary: {
            iterations: 0,
            graphDepth: 0,
            metadataNodes: 0,
            relationships: 0,
            newDependencies: 0,
            warnings: []
        }
    };

    if (!repoUrl || !sourceBranch) {
        const warnings = [
            'Repository URL or source branch not provided; graph expansion skipped.'
        ];
        console.log('Graph expansion skipped:', warnings[0]);
        return { ...empty, warnings, summary: { ...empty.summary, warnings } };
    }

    const seedNodes = collectSeedNodes({
        selectedMetadata,
        discoveredRelationships,
        discoveredReferences,
        enrichedDependencies
    });

    if (!seedNodes.length) {
        console.log('Graph expansion seeds: 0');
        logSection('Metadata Graph Expansion Summary');
        return empty;
    }

    try {
        return await withClonedRepository(
            { repoUrl, branch: sourceBranch },
            async (readRepoFile, listRepoFiles) => {
                const repoFiles = await listRepoFiles();
                const queue = [...seedNodes];
                const visited = new Set();
                const queued = new Set(
                    seedNodes.map(getNodeKey).filter(Boolean)
                );
                const nodeMap = new Map();
                const edgeMap = new Map();
                const warnings = [];
                let iterations = 0;
                let graphDepth = 0;

                for (const seed of seedNodes) {
                    const key = getNodeKey(seed);

                    if (key && !nodeMap.has(key)) {
                        nodeMap.set(key, seed);
                    }
                }

                while (queue.length > 0) {
                    if (nodeMap.size >= MAX_NODE_COUNT) {
                        warnings.push(
                            `Graph expansion stopped at maximum node count ${MAX_NODE_COUNT}.`
                        );
                        break;
                    }

                    if (graphDepth >= MAX_GRAPH_DEPTH) {
                        warnings.push(
                            `Graph expansion stopped at maximum depth ${MAX_GRAPH_DEPTH}.`
                        );
                        break;
                    }

                    const current = queue.shift();
                    const currentKey = getNodeKey(current);

                    if (!currentKey || visited.has(currentKey)) {
                        continue;
                    }

                    visited.add(currentKey);
                    iterations += 1;
                    graphDepth = Math.max(graphDepth, (current.depth || 0) + 1);

                    const discoverer = getDiscovererForMetadataType(
                        current.metadataType
                    );

                    if (!discoverer) {
                        continue;
                    }

                    let discovery = createEmptyDiscoveryResult();

                    try {
                        discovery = await discoverer.discover({
                            metadata: current,
                            repoFiles,
                            readRepoFile,
                            listRepoFiles,
                            depth: (current.depth || 0) + 1
                        });
                    } catch (error) {
                        warnings.push(
                            `Discoverer ${discoverer.id} failed for ${currentKey}: ${
                                error?.message || 'unknown error'
                            }`
                        );
                        continue;
                    }

                    warnings.push(...(discovery.warnings || []));

                    for (const edge of discovery.discoveredEdges || []) {
                        const edgeKey = getEdgeKey(edge);

                        if (edgeKey && !edgeMap.has(edgeKey)) {
                            edgeMap.set(edgeKey, edge);
                        }
                    }

                    for (const node of discovery.discoveredNodes || []) {
                        const nodeKey = getNodeKey(node);

                        if (!nodeKey) {
                            continue;
                        }

                        if (!nodeMap.has(nodeKey)) {
                            nodeMap.set(nodeKey, node);
                        }

                        const shouldEnqueue =
                            node.deployable === true &&
                            !visited.has(nodeKey) &&
                            !queued.has(nodeKey) &&
                            Boolean(
                                getDiscovererForMetadataType(node.metadataType)
                            );

                        if (shouldEnqueue) {
                            queued.add(nodeKey);
                            const queuedNode = {
                                ...node,
                                metadataName: node.name,
                                depth: node.depth || (current.depth || 0) + 1
                            };
                            queue.push(queuedNode);
                        }
                    }

                    console.log(
                        `Expansion visited ${currentKey} → +${
                            (discovery.discoveredNodes || []).length
                        } nodes`
                    );
                }

                const discoveredNodes = [...nodeMap.values()].filter((node) => {
                    const key = getNodeKey(node);
                    // Exclude pure seeds that were never produced as discoveries
                    // when reporting "new" deps — still return all deployable nodes
                    // for merge. Seed-only nodes without discovery origin are fine
                    // to include; resolution dedupes against selection.
                    return Boolean(key);
                });

                const discoveredEdges = [...edgeMap.values()];
                const expansionBornNodes = discoveredNodes.filter(
                    (node) =>
                        node.discoveredBy &&
                        node.discoveredBy !== 'SELECTED' &&
                        (node.discoveryMethod || node.sourceMetadata)
                );

                const references = expansionBornNodes
                    .filter((node) => node.deployable === true)
                    .map(nodeToReference);

                const dependencies = expansionBornNodes
                    .filter((node) => node.deployable === true)
                    .map(nodeToDependency);

                const summary = {
                    iterations,
                    graphDepth,
                    metadataNodes: nodeMap.size,
                    relationships: discoveredEdges.length,
                    newDependencies: expansionBornNodes.length,
                    warnings: [...warnings]
                };

                console.log('Graph expansion iterations:', iterations);
                console.log('Graph depth:', graphDepth);
                console.log('Metadata nodes:', nodeMap.size);
                console.log('Edges:', discoveredEdges.length);
                console.log('New dependencies:', expansionBornNodes.length);
                console.log(
                    'Warnings:',
                    warnings.length ? warnings : '(none)'
                );
                logSection('Metadata Graph Expansion Summary');

                return {
                    discoveredNodes: expansionBornNodes,
                    discoveredEdges,
                    discoveredReferences: references,
                    discoveredDependencies: dependencies,
                    warnings,
                    summary
                };
            }
        );
    } catch (error) {
        const warnings = [
            error?.message ||
                'Metadata graph expansion failed; continuing with existing discoveries.'
        ];

        console.log('Graph expansion failed:', warnings[0]);
        logSection('Metadata Graph Expansion Summary');

        return {
            ...empty,
            warnings,
            summary: { ...empty.summary, warnings }
        };
    }
}

module.exports = {
    expandMetadataGraph,
    collectSeedNodes,
    toFrontierNode,
    MAX_GRAPH_DEPTH,
    MAX_NODE_COUNT
};
