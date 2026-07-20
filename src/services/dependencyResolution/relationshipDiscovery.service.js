const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const { getRegisteredDiscoverers } = require('./relationshipRegistry');

const execAsync = util.promisify(exec);

const MAX_GRAPH_DEPTH = 10;

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function getDependencyKey(dependency) {
    const type = dependency?.type || dependency?.metadataType;
    const name = dependency?.name || dependency?.metadataName;

    if (!type || !name) {
        return null;
    }

    return `${type}:${name}`;
}

function normalizeExistingDependencies(requiredDependencies) {
    if (!Array.isArray(requiredDependencies)) {
        return [];
    }

    return requiredDependencies.filter(
        (item) => item?.name && (item?.type || item?.metadataType)
    );
}

function toDependencyGraphItem(relationship) {
    return {
        name: relationship.name,
        type: relationship.metadataType || relationship.type || 'CustomObject',
        metadataType:
            relationship.metadataType || relationship.type || 'CustomObject',
        relationship: relationship.relationship,
        required: relationship.required !== false,
        selected: relationship.selected !== false,
        discoveredBy: relationship.discoveredBy,
        sourceMetadata: relationship.sourceMetadata,
        sourceField: relationship.sourceField,
        discoveryMethod: relationship.discoveryMethod,
        reason: relationship.reason,
        depth: relationship.depth || 1
    };
}

function mergeDependencies(existingDependencies, discoveredRelationships) {
    const merged = [];
    const dependencyMap = new Map();

    for (const dependency of existingDependencies) {
        const key = getDependencyKey(dependency);

        if (!key || dependencyMap.has(key)) {
            continue;
        }

        const normalized = {
            ...dependency,
            type: dependency.type || dependency.metadataType,
            metadataType: dependency.metadataType || dependency.type
        };

        dependencyMap.set(key, normalized);
        merged.push(normalized);
    }

    for (const relationship of discoveredRelationships) {
        const graphItem = toDependencyGraphItem(relationship);
        const key = getDependencyKey(graphItem);

        if (!key) {
            continue;
        }

        if (dependencyMap.has(key)) {
            const existing = dependencyMap.get(key);

            if (!existing.relationship && graphItem.relationship) {
                existing.relationship = graphItem.relationship;
            }

            if (!existing.discoveredBy && graphItem.discoveredBy) {
                existing.discoveredBy = graphItem.discoveredBy;
                existing.sourceMetadata = graphItem.sourceMetadata;
                existing.sourceField = graphItem.sourceField;
                existing.discoveryMethod = graphItem.discoveryMethod;
                existing.reason = graphItem.reason || existing.reason;
            }

            if (existing.depth == null && graphItem.depth != null) {
                existing.depth = graphItem.depth;
            }

            continue;
        }

        dependencyMap.set(key, graphItem);
        merged.push(graphItem);
    }

    return merged;
}

function buildSummary({
    metadataScanned,
    filesScanned,
    relationships,
    warnings
}) {
    let lookupRelationships = 0;
    let masterDetailRelationships = 0;

    for (const relationship of relationships) {
        if (relationship.relationship === 'Lookup') {
            lookupRelationships += 1;
        } else if (relationship.relationship === 'MasterDetail') {
            masterDetailRelationships += 1;
        }
    }

    return {
        metadataScanned,
        filesScanned,
        relationshipsDiscovered: relationships.length,
        lookupRelationships,
        masterDetailRelationships,
        warnings: [...warnings]
    };
}

function buildGraphExpansionSummary({
    iterations,
    graphDepth,
    metadataNodes,
    relationships,
    newDependencies,
    warnings
}) {
    return {
        iterations,
        graphDepth,
        metadataNodes,
        relationships,
        newDependencies,
        warnings: [...warnings]
    };
}

function logDiscoveryResults(relationships, summary) {
    console.log('Selected metadata scanned:', summary.metadataScanned);
    console.log('Files scanned:', summary.filesScanned);
    console.log('Relationships discovered:', summary.relationshipsDiscovered);

    for (const relationship of relationships) {
        console.log('Relationship');
        console.log(relationship.relationship);
        if (relationship.sourceField) {
            console.log(
                `${relationship.sourceMetadata}.${relationship.sourceField}`
            );
        } else {
            console.log(relationship.sourceMetadata);
        }
        console.log('↓');
        console.log(relationship.name);
        console.log('Depth:', relationship.depth || 1);
        console.log('Discovered');
        console.log('Reason');
        console.log(relationship.reason);
        console.log('------------------------------------');
    }

    console.log('Summary:');
    console.log('Lookup relationships:', summary.lookupRelationships);
    console.log(
        'Master-Detail relationships:',
        summary.masterDetailRelationships
    );
    console.log(
        'Warnings:',
        summary.warnings.length ? summary.warnings : '(none)'
    );

    logSection('Relationship Discovery Summary');
}

function logGraphExpansionIteration({
    iteration,
    depth,
    metadataScanned,
    newRelationships
}) {
    logSection('Metadata Graph Expansion');
    console.log('Iteration:', iteration);
    console.log('Graph depth:', depth);
    console.log('Metadata scanned:', metadataScanned);
    console.log('Relationships discovered:', newRelationships.length);

    for (const relationship of newRelationships) {
        console.log(`Depth ${relationship.depth}`);
        console.log(relationship.sourceMetadata);
        console.log('↓');
        console.log(relationship.name);
        console.log(relationship.relationship);
        console.log('Discovered');
        console.log('------------------------------------');
    }
}

function toScanTarget(item) {
    if (!item) {
        return null;
    }

    if (item.metadataType && (item.metadataName || item.filePath)) {
        return {
            metadataType: item.metadataType,
            metadataName: item.metadataName || item.name || null,
            filePath: item.filePath || null
        };
    }

    if ((item.type || item.metadataType) && item.name) {
        return {
            metadataType: item.metadataType || item.type,
            metadataName: item.name,
            filePath: item.filePath || null
        };
    }

    return null;
}

function relationshipToScanTarget(relationship) {
    if (!relationship?.name || !relationship?.metadataType) {
        return null;
    }

    // Only CustomObject nodes expand further in this phase.
    // FlexiPage and other types become leaf nodes until future discoverers exist.
    if (relationship.metadataType !== 'CustomObject') {
        return null;
    }

    return {
        metadataType: 'CustomObject',
        metadataName: relationship.name,
        filePath: null
    };
}

async function runDiscoverersForFrontier({
    frontier,
    discoverers,
    repoFiles,
    readRepoFile,
    depth
}) {
    const relationships = [];
    const warnings = [];
    let metadataScanned = 0;
    let filesScanned = 0;

    for (const discoverer of discoverers) {
        const result = await discoverer.discover({
            selectedMetadata: frontier,
            repoFiles,
            readRepoFile,
            depth
        });

        relationships.push(...(result.relationships || []));
        warnings.push(...(result.warnings || []));
        metadataScanned += result.metadataScanned || 0;
        filesScanned += result.filesScanned || 0;
    }

    return {
        relationships,
        warnings,
        metadataScanned,
        filesScanned
    };
}

/**
 * Expand the dependency graph until no new discoverable metadata appears.
 */
async function discoverUntilStable({
    selectedMetadata,
    discoverers,
    repoFiles,
    readRepoFile
}) {
    const allRelationships = [];
    const relationshipKeys = new Set();
    const visitedMetadata = new Set();
    const warnings = [];
    let metadataScanned = 0;
    let filesScanned = 0;
    let iterations = 0;
    let graphDepth = 0;
    let newDependencies = 0;

    let frontier = (selectedMetadata || [])
        .map(toScanTarget)
        .filter(Boolean);

    while (frontier.length > 0 && graphDepth < MAX_GRAPH_DEPTH) {
        const unscannedFrontier = [];

        for (const item of frontier) {
            const key = getDependencyKey(item);

            if (!key || visitedMetadata.has(key)) {
                continue;
            }

            visitedMetadata.add(key);
            unscannedFrontier.push(item);
        }

        if (unscannedFrontier.length === 0) {
            break;
        }

        iterations += 1;
        graphDepth += 1;

        const iterationResult = await runDiscoverersForFrontier({
            frontier: unscannedFrontier,
            discoverers,
            repoFiles,
            readRepoFile,
            depth: graphDepth
        });

        metadataScanned += iterationResult.metadataScanned;
        filesScanned += iterationResult.filesScanned;
        warnings.push(...iterationResult.warnings);

        const newlyDiscovered = [];

        for (const relationship of iterationResult.relationships) {
            const key = getDependencyKey(relationship);

            if (!key || relationshipKeys.has(key)) {
                continue;
            }

            relationshipKeys.add(key);
            allRelationships.push(relationship);
            newlyDiscovered.push(relationship);
            newDependencies += 1;
        }

        logGraphExpansionIteration({
            iteration: iterations,
            depth: graphDepth,
            metadataScanned: unscannedFrontier.length,
            newRelationships: newlyDiscovered
        });

        frontier = newlyDiscovered
            .map(relationshipToScanTarget)
            .filter(Boolean);
    }

    if (graphDepth >= MAX_GRAPH_DEPTH && frontier.length > 0) {
        warnings.push(
            `Graph expansion stopped at maximum depth ${MAX_GRAPH_DEPTH}.`
        );
    }

    console.log('Graph expansion iterations:', iterations);
    console.log('Graph depth:', graphDepth);
    console.log('Metadata nodes visited:', visitedMetadata.size);
    console.log('New dependencies:', newDependencies);
    logSection('Metadata Graph Expansion Summary');

    return {
        relationships: allRelationships,
        warnings,
        metadataScanned,
        filesScanned,
        graphExpansionSummary: buildGraphExpansionSummary({
            iterations,
            graphDepth,
            metadataNodes: visitedMetadata.size,
            relationships: allRelationships.length,
            newDependencies,
            warnings
        })
    };
}

async function withClonedRepository({ repoUrl, branch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = path.join(
        os.tmpdir(),
        `relationship-discovery-${Date.now()}`
    );

    const authenticatedUrl =
        githubToken && repoUrl?.startsWith('https://')
            ? repoUrl.replace('https://', `https://${githubToken}@`)
            : repoUrl;

    try {
        await execAsync(
            `git clone ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );
        await execAsync(
            `cd ${shellQuote(repoPath)} && git fetch --all`
        );

        const readRepoFile = async (targetPath) => {
            const fileContent = await execAsync(
                `cd ${shellQuote(repoPath)} && git show origin/${branch}:"${targetPath}"`
            );

            return fileContent.stdout;
        };

        const listRepoFiles = async () => {
            const result = await execAsync(
                `cd ${shellQuote(repoPath)} && git ls-tree -r --name-only origin/${branch}`
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
            // Cleanup best-effort; discovery results already returned.
        }
    }
}

/**
 * Discover relationship-based dependencies and enrich the dependency graph.
 * Expands recursively until the graph is stable.
 * Does not decide deployment actions or modify packages/metadata.
 *
 * @param {{
 *   selectedMetadata?: Array,
 *   requiredDependencies?: Array,
 *   repoUrl?: string,
 *   sourceBranch?: string
 * }} options
 */
async function discoverRelationships({
    selectedMetadata,
    requiredDependencies,
    repoUrl,
    sourceBranch
} = {}) {
    logSection('Relationship Discovery Engine');

    const existingDependencies = normalizeExistingDependencies(
        requiredDependencies
    );
    const emptyGraphExpansionSummary = buildGraphExpansionSummary({
        iterations: 0,
        graphDepth: 0,
        metadataNodes: 0,
        relationships: 0,
        newDependencies: 0,
        warnings: []
    });
    const emptySummary = buildSummary({
        metadataScanned: 0,
        filesScanned: 0,
        relationships: [],
        warnings: []
    });

    if (!repoUrl || !sourceBranch) {
        const warnings = [
            'Repository URL or source branch not provided; relationship discovery skipped.'
        ];
        const summary = buildSummary({
            metadataScanned: 0,
            filesScanned: 0,
            relationships: [],
            warnings
        });

        console.log('Selected metadata scanned: 0');
        console.log('Files scanned: 0');
        console.log('Relationships discovered: 0');
        console.log('Warnings:', warnings);
        logSection('Relationship Discovery Summary');

        return {
            discoveredRelationships: [],
            enrichedDependencies: existingDependencies,
            summary,
            graphExpansionSummary: {
                ...emptyGraphExpansionSummary,
                warnings
            }
        };
    }

    if (!Array.isArray(selectedMetadata) || selectedMetadata.length === 0) {
        console.log('Selected metadata scanned: 0');
        console.log('Files scanned: 0');
        console.log('Relationships discovered: 0');
        logSection('Relationship Discovery Summary');

        return {
            discoveredRelationships: [],
            enrichedDependencies: existingDependencies,
            summary: emptySummary,
            graphExpansionSummary: emptyGraphExpansionSummary
        };
    }

    const discoverers = getRegisteredDiscoverers();

    try {
        return await withClonedRepository(
            { repoUrl, branch: sourceBranch },
            async (readRepoFile, listRepoFiles) => {
                const repoFiles = await listRepoFiles();

                const expansionResult = await discoverUntilStable({
                    selectedMetadata,
                    discoverers,
                    repoFiles,
                    readRepoFile
                });

                const relationships = expansionResult.relationships;
                const summary = buildSummary({
                    metadataScanned: expansionResult.metadataScanned,
                    filesScanned: expansionResult.filesScanned,
                    relationships,
                    warnings: expansionResult.warnings
                });

                logDiscoveryResults(relationships, summary);

                return {
                    discoveredRelationships: relationships,
                    enrichedDependencies: mergeDependencies(
                        existingDependencies,
                        relationships
                    ),
                    summary,
                    graphExpansionSummary: expansionResult.graphExpansionSummary
                };
            }
        );
    } catch (error) {
        const warnings = [
            error?.message ||
                'Relationship discovery failed; continuing with existing dependencies.'
        ];
        const summary = buildSummary({
            metadataScanned: 0,
            filesScanned: 0,
            relationships: [],
            warnings
        });

        console.log('Selected metadata scanned: 0');
        console.log('Files scanned: 0');
        console.log('Relationships discovered: 0');
        console.log('Warnings:', warnings);
        logSection('Relationship Discovery Summary');

        return {
            discoveredRelationships: [],
            enrichedDependencies: existingDependencies,
            summary,
            graphExpansionSummary: {
                ...emptyGraphExpansionSummary,
                warnings
            }
        };
    }
}

module.exports = {
    discoverRelationships,
    discoverUntilStable
};
