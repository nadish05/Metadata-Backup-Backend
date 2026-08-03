const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const { getRegisteredDiscoverers } = require('./relationshipRegistry');
const deploymentReviewService = require('../deploymentReview.service');
const {
    METADATA_ORIGINS
} = require('./metadataGraphOrigin.model');
const { logBookingTrace } = require('../bookingTrace.temp');

const execAsync = util.promisify(exec);

const MAX_GRAPH_DEPTH = 10;

/**
 * Dependency types that expand through relationship discoverers even when they
 * are not user-selected primary metadata (e.g. Flow/Apex → CustomField).
 * Keeps expansion generic — not Flow-specific.
 */
const EXPANDABLE_DEPENDENCY_TYPES = Object.freeze(['CustomField']);

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
        origin:
            relationship.origin || METADATA_ORIGINS.RELATIONSHIP_TARGET,
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

/**
 * Build the initial relationship-discovery frontier.
 * Primary selected metadata plus expandable dependency types (CustomField).
 * Deduplicates by type:name. Does not invent new parsers.
 *
 * @param {Array<object>} selectedMetadata
 * @param {Array<object>} expandableDependencies
 * @returns {Array<object>}
 */
function buildInitialFrontier(selectedMetadata = [], expandableDependencies = []) {
    const frontier = [];
    const seen = new Set();
    const expandableTypeSet = new Set(EXPANDABLE_DEPENDENCY_TYPES);

    function addItem(item) {
        const target = toScanTarget(item);

        if (!target) {
            return;
        }

        const key = getDependencyKey(target);

        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        frontier.push(target);
    }

    for (const item of selectedMetadata || []) {
        addItem(item);
    }

    for (const item of expandableDependencies || []) {
        const type = item?.type || item?.metadataType;

        if (!expandableTypeSet.has(type)) {
            continue;
        }

        addItem(item);
    }

    return frontier;
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

function isReviewableDeployableMetadata(item) {
    const metadataType = item?.metadataType || item?.type;

    return deploymentReviewService.isSupportedReviewMetadataType(metadataType);
}

function summarizeReviewDependencies(requiredDependencies) {
    const counts = {};

    for (const dependency of requiredDependencies || []) {
        const type = dependency.type || 'Unknown';
        counts[type] = (counts[type] || 0) + 1;
    }

    return counts;
}

function logReviewMerge(metadataLabel, requiredDependencies) {
    const counts = summarizeReviewDependencies(requiredDependencies);
    const entries = Object.entries(counts);

    if (!entries.length) {
        console.log('Added');
        console.log('(none)');
        return;
    }

    console.log('Added');

    for (const [type, count] of entries) {
        console.log(`${count} ${type}${count === 1 ? '' : 's'}`);
    }
}

async function reviewNewlyDiscoveredMetadata({
    newlyDiscovered,
    reviewedMetadata,
    readRepoFile,
    listRepoFiles,
    relationshipKeys,
    allRelationships
}) {
    let reviewsExecuted = 0;
    let reviewsSkipped = 0;
    const warnings = [];
    const reviewFrontierAdditions = [];

    for (const discovered of newlyDiscovered) {
        const metadataType = discovered.metadataType || discovered.type;
        const metadataName = discovered.name;
        const key = getDependencyKey({
            metadataType,
            metadataName: metadataName
        });

        if (!key) {
            continue;
        }

        if (!isReviewableDeployableMetadata(discovered)) {
            reviewsSkipped += 1;
            continue;
        }

        if (reviewedMetadata.has(key)) {
            reviewsSkipped += 1;
            console.log('Skipping Deployment Review (already reviewed)');
            console.log(key);
            continue;
        }

        reviewedMetadata.add(key);

        logSection('Deployment Review Started');
        console.log(metadataName);
        console.log('Type:', metadataType);

        try {
            const reviewResult =
                await deploymentReviewService.reviewDeployableMetadataItems({
                    items: [
                        {
                            metadataType,
                            metadataName,
                            name: metadataName,
                            filePath: discovered.filePath || null,
                            origin:
                                discovered.origin ||
                                METADATA_ORIGINS.RELATIONSHIP_TARGET
                        }
                    ],
                    readRepoFile,
                    listRepoFiles,
                    defaultOrigin: METADATA_ORIGINS.RELATIONSHIP_TARGET
                });

            reviewsExecuted += reviewResult.reviewsExecuted || 0;
            reviewsSkipped += reviewResult.reviewsSkipped || 0;
            warnings.push(...(reviewResult.warnings || []));

            console.log('Deployment Review Complete');
            console.log(
                'Origin:',
                discovered.origin || METADATA_ORIGINS.RELATIONSHIP_TARGET
            );
            console.log(
                'Strategy:',
                reviewResult.deploymentReview?.[0]?.reviewStrategy || 'N/A'
            );
            logReviewMerge(metadataName, reviewResult.requiredDependencies);
            console.log('Merged into Deployment Graph');

            for (const dependency of reviewResult.requiredDependencies || []) {
                const dependencyKey = getDependencyKey(dependency);

                if (!dependencyKey) {
                    continue;
                }

                const graphItem = {
                    name: dependency.name,
                    type: dependency.type,
                    metadataType: dependency.type,
                    relationship: dependency.relationship || 'DeploymentReview',
                    required: dependency.required !== false,
                    selected: dependency.selected !== false,
                    origin:
                        dependency.origin ||
                        METADATA_ORIGINS.SECONDARY_DEPENDENCY,
                    discoveredBy: 'DeploymentReview',
                    sourceMetadata: metadataName,
                    sourceField: dependency.sourceField || null,
                    discoveryMethod: 'deploymentReview',
                    reason:
                        dependency.reason ||
                        `Discovered by Deployment Review of ${metadataName}.`,
                    depth: (discovered.depth || 1) + 1
                };

                if (!relationshipKeys.has(dependencyKey)) {
                    relationshipKeys.add(dependencyKey);
                    allRelationships.push(graphItem);
                }

                // CustomObjects found via review (e.g. Apex analysis) can enter
                // the existing Relationship Discovery frontier.
                if (
                    dependency.type === 'CustomObject' &&
                    !reviewedMetadata.has(dependencyKey)
                ) {
                    const scanTarget = relationshipToScanTarget({
                        name: dependency.name,
                        metadataType: 'CustomObject'
                    });

                    if (scanTarget) {
                        reviewFrontierAdditions.push({
                            ...scanTarget,
                            origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY
                        });
                    }
                }
            }
        } catch (error) {
            warnings.push(
                `Deployment Review failed for ${key}: ${
                    error?.message || 'unknown error'
                }`
            );
            console.log('Deployment Review Failed');
            console.log(error?.message || error);
        }
    }

    return {
        reviewsExecuted,
        reviewsSkipped,
        warnings,
        reviewFrontierAdditions
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
 * After each discovery batch, newly discovered deployable metadata receives
 * the same Deployment Review as user-selected metadata.
 */
async function discoverUntilStable({
    selectedMetadata,
    expandableDependencies = [],
    discoverers,
    repoFiles,
    readRepoFile,
    listRepoFiles
}) {
    const allRelationships = [];
    const relationshipKeys = new Set();
    const visitedMetadata = new Set();
    const reviewedMetadata = new Set();
    const warnings = [];
    let metadataScanned = 0;
    let filesScanned = 0;
    let iterations = 0;
    let graphDepth = 0;
    let newDependencies = 0;
    let deploymentReviewsExecuted = 0;
    let deploymentReviewsSkipped = 0;

    let frontier = buildInitialFrontier(
        selectedMetadata,
        expandableDependencies
    );

    // User-selected metadata is reviewed upstream; do not re-review here.
    // Expandable dependency seeds (e.g. CustomField) are also marked reviewed
    // so relationship expansion does not re-run Review on them.
    for (const item of frontier) {
        const key = getDependencyKey(item);

        if (key) {
            reviewedMetadata.add(key);
        }
    }

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

            const withOrigin = {
                ...relationship,
                origin:
                    relationship.origin ||
                    METADATA_ORIGINS.RELATIONSHIP_TARGET
            };

            relationshipKeys.add(key);
            allRelationships.push(withOrigin);
            newlyDiscovered.push(withOrigin);
            newDependencies += 1;
        }

        logGraphExpansionIteration({
            iteration: iterations,
            depth: graphDepth,
            metadataScanned: unscannedFrontier.length,
            newRelationships: newlyDiscovered
        });

        const reviewResult = await reviewNewlyDiscoveredMetadata({
            newlyDiscovered,
            reviewedMetadata,
            readRepoFile,
            listRepoFiles: listRepoFiles || (async () => repoFiles),
            relationshipKeys,
            allRelationships
        });

        deploymentReviewsExecuted += reviewResult.reviewsExecuted || 0;
        deploymentReviewsSkipped += reviewResult.reviewsSkipped || 0;
        warnings.push(...(reviewResult.warnings || []));

        const relationshipFrontier = newlyDiscovered
            .map(relationshipToScanTarget)
            .filter(Boolean);

        frontier = [
            ...relationshipFrontier,
            ...(reviewResult.reviewFrontierAdditions || [])
        ];
    }

    if (graphDepth >= MAX_GRAPH_DEPTH && frontier.length > 0) {
        warnings.push(
            `Graph expansion stopped at maximum depth ${MAX_GRAPH_DEPTH}.`
        );
    }

    console.log('Discovery Complete');
    console.log('Graph expansion iterations:', iterations);
    console.log('Graph depth:', graphDepth);
    console.log('Deployment Graph Size:', allRelationships.length);
    console.log('Objects Reviewed / Visited:', visitedMetadata.size);
    console.log('Deployment Reviews Executed:', deploymentReviewsExecuted);
    console.log('Skipped Reviews:', deploymentReviewsSkipped);
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
        }),
        deploymentReviewSummary: {
            reviewsExecuted: deploymentReviewsExecuted,
            reviewsSkipped: deploymentReviewsSkipped,
            objectsReviewed: reviewedMetadata.size
        }
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
                    expandableDependencies: existingDependencies,
                    discoverers,
                    repoFiles,
                    readRepoFile,
                    listRepoFiles
                });

                const relationships = expansionResult.relationships;
                const summary = buildSummary({
                    metadataScanned: expansionResult.metadataScanned,
                    filesScanned: expansionResult.filesScanned,
                    relationships,
                    warnings: expansionResult.warnings
                });

                logDiscoveryResults(relationships, summary);

                const enrichedDependencies = mergeDependencies(
                    existingDependencies,
                    relationships
                );

                // TEMPORARY DEBUG — Phase 10.13 Part 2
                logBookingTrace({
                    stage: 'PART 2 — relationshipDiscovery.discoverRelationships() return',
                    collection: 'newRelationships (discoveredRelationships)',
                    items: relationships,
                    caller: 'discoverRelationships',
                    method: 'discoverRelationships'
                });
                logBookingTrace({
                    stage: 'PART 2 — relationshipDiscovery.discoverRelationships() return',
                    collection: 'newDependencies (enrichedDependencies)',
                    items: enrichedDependencies,
                    caller: 'discoverRelationships',
                    method: 'discoverRelationships'
                });
                logBookingTrace({
                    stage: 'PART 2 — relationshipDiscovery.discoverRelationships() return',
                    collection: 'newMetadata (selectedMetadata input; not mutated)',
                    items: selectedMetadata,
                    caller: 'discoverRelationships',
                    method: 'discoverRelationships'
                });

                return {
                    discoveredRelationships: relationships,
                    enrichedDependencies,
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
    discoverUntilStable,
    buildInitialFrontier,
    EXPANDABLE_DEPENDENCY_TYPES
};
