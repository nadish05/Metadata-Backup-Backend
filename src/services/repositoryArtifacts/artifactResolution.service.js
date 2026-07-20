/**
 * Repository Artifact Resolution.
 *
 * Bridges logical deployment-graph nodes to physical repository artifacts.
 * Does not discover dependencies, review metadata, or make deploy decisions.
 */

const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const { getArtifactResolver } = require('./artifactResolverRegistry');

const execAsync = util.promisify(exec);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function getNodeKey(node) {
    const metadataType = node?.metadataType || node?.type || null;
    const name = node?.metadataName || node?.name || null;

    if (!metadataType || !name) {
        return null;
    }

    return `${metadataType}:${name}`;
}

function normalizeNode(node) {
    const metadataType = node?.metadataType || node?.type || null;
    const name = node?.metadataName || node?.name || null;

    if (!metadataType || !name) {
        return null;
    }

    return {
        ...node,
        metadataType,
        type: metadataType,
        metadataName: name,
        name
    };
}

function collectGraphNodes({
    selectedMetadata = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    enrichedDependencies = []
}) {
    const nodes = [];
    const seen = new Set();

    function add(item) {
        const normalized = normalizeNode(item);
        const key = getNodeKey(normalized);

        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        nodes.push(normalized);
    }

    for (const item of selectedMetadata) {
        add(item);
    }

    for (const item of discoveredRelationships) {
        add(item);
    }

    for (const item of enrichedDependencies) {
        add(item);
    }

    for (const item of discoveredReferences) {
        add(item);
    }

    return nodes;
}

function enrichNode(node, repoFiles) {
    const metadataType = node.metadataType;
    const name = node.name;

    if (node.filePath && node.artifactResolved === true) {
        return {
            ...node,
            filePath: String(node.filePath).replace(/\\/g, '/'),
            sourceExists: true,
            artifactResolved: true
        };
    }

    const resolver = getArtifactResolver(metadataType);

    if (!resolver) {
        return {
            ...node,
            filePath: node.filePath || null,
            sourceExists: false,
            artifactResolved: false
        };
    }

    let resolvedPath = null;

    try {
        resolvedPath = resolver.resolve({
            name,
            metadataType,
            metadataName: name,
            filePath: node.filePath || null,
            repoFiles
        });
    } catch (error) {
        return {
            ...node,
            filePath: null,
            sourceExists: false,
            artifactResolved: false,
            artifactWarning:
                error?.message ||
                `Artifact resolver ${resolver.id} failed for ${metadataType}:${name}`
        };
    }

    if (!resolvedPath && node.filePath) {
        const normalizedExisting = String(node.filePath).replace(/\\/g, '/');
        const existsInIndex = (repoFiles || []).some(
            (repoFile) =>
                String(repoFile).replace(/\\/g, '/') === normalizedExisting ||
                String(repoFile)
                    .replace(/\\/g, '/')
                    .startsWith(`${normalizedExisting}/`)
        );

        if (existsInIndex) {
            resolvedPath = normalizedExisting;
        }
    }

    const artifactResolved = Boolean(resolvedPath);

    return {
        ...node,
        filePath: resolvedPath || null,
        sourceExists: artifactResolved,
        artifactResolved
    };
}

function applyEnrichmentToCollection(collection, enrichmentByKey) {
    if (!Array.isArray(collection)) {
        return [];
    }

    return collection.map((item) => {
        const key = getNodeKey(item);

        if (!key || !enrichmentByKey.has(key)) {
            return item;
        }

        const enrichment = enrichmentByKey.get(key);

        return {
            ...item,
            filePath: enrichment.filePath,
            sourceExists: enrichment.sourceExists,
            artifactResolved: enrichment.artifactResolved
        };
    });
}

async function withRepositoryIndex({ repoUrl, branch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = path.join(
        os.tmpdir(),
        `artifact-resolution-${Date.now()}`
    );

    const authenticatedUrl =
        githubToken && repoUrl?.startsWith('https://')
            ? repoUrl.replace('https://', `https://${githubToken}@`)
            : repoUrl;

    try {
        await execAsync(
            `git clone --branch ${shellQuote(branch)} --single-branch ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );

        const listRepoFiles = async () => {
            const result = await execAsync(
                `cd ${shellQuote(repoPath)} && git ls-tree -r --name-only HEAD`
            );

            return result.stdout
                .split('\n')
                .map((line) => line.trim().replace(/\\/g, '/'))
                .filter(Boolean);
        };

        return await callback(await listRepoFiles());
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
 * Resolve repository artifacts for all deployment-graph nodes.
 */
async function resolveRepositoryArtifacts({
    selectedMetadata = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    enrichedDependencies = [],
    repoUrl,
    sourceBranch,
    repoFiles = null
} = {}) {
    logSection('Repository Artifact Resolution');

    const emptyResult = {
        selectedMetadata,
        discoveredRelationships,
        discoveredReferences,
        enrichedDependencies,
        resolvedNodes: [],
        summary: {
            nodesResolved: 0,
            artifactsFound: 0,
            artifactsMissing: 0,
            warnings: []
        }
    };

    if (!repoUrl || !sourceBranch) {
        const warnings = [
            'Repository URL or source branch not provided; artifact resolution skipped.'
        ];
        console.log(warnings[0]);
        logSection('Repository Artifact Resolution Summary');

        return {
            ...emptyResult,
            summary: { ...emptyResult.summary, warnings }
        };
    }

    const runResolution = (files) => {
        const graphNodes = collectGraphNodes({
            selectedMetadata,
            discoveredRelationships,
            discoveredReferences,
            enrichedDependencies
        });

        // DEBUG ONLY — temporary diagnostics.
        console.log('========================================');
        console.log('ARTIFACT RESOLUTION START');
        console.log('========================================');
        console.log('Total Graph Nodes:');
        console.log(graphNodes.length);
        console.log('Total Repository Files:');
        console.log(Array.isArray(files) ? files.length : 0);

        const resolvedNodes = [];
        const enrichmentByKey = new Map();
        const warnings = [];
        let artifactsFound = 0;
        let artifactsMissing = 0;
        const resolvedList = [];
        const unresolvedList = [];

        for (const node of graphNodes) {
            if (node.metadataType === 'CustomObject') {
                console.log('----------------------------------------');
                console.log('Resolving CustomObject');
                console.log('----------------------------------------');
                console.log('Metadata Name:');
                console.log(node.name);
                console.log('Metadata Type:');
                console.log(node.metadataType);
            }

            const enriched = enrichNode(node, files);
            const key = getNodeKey(enriched);

            if (node.metadataType === 'CustomObject') {
                console.log('----------------------------------------');
                console.log('Resolver decision');
                console.log('----------------------------------------');
                console.log('Resolved:', enriched.artifactResolved === true);
                console.log('Resolved Path:');
                console.log(enriched.filePath);
                console.log('sourceExists:');
                console.log(enriched.sourceExists);
                console.log('artifactResolved:');
                console.log(enriched.artifactResolved);
            }

            resolvedNodes.push(enriched);

            if (key) {
                enrichmentByKey.set(key, enriched);
            }

            if (enriched.artifactResolved) {
                artifactsFound += 1;
                resolvedList.push(`${enriched.metadataType}:${enriched.name}`);
            } else {
                artifactsMissing += 1;
                unresolvedList.push(
                    `${enriched.metadataType}:${enriched.name}`
                );
                warnings.push(
                    `Source artifact not found for ${enriched.metadataType}:${enriched.name}`
                );
            }

            if (enriched.artifactWarning) {
                warnings.push(enriched.artifactWarning);
            }
        }

        const summary = {
            nodesResolved: resolvedNodes.length,
            artifactsFound,
            artifactsMissing,
            warnings
        };

        console.log('========================================');
        console.log('ARTIFACT RESOLUTION SUMMARY');
        console.log('========================================');
        console.log('Resolved:');
        console.log(resolvedList.length ? resolvedList : '(none)');
        console.log('Unresolved:');
        console.log(unresolvedList.length ? unresolvedList : '(none)');
        console.log('Nodes resolved:', summary.nodesResolved);
        console.log('Artifacts found:', summary.artifactsFound);
        console.log('Artifacts missing:', summary.artifactsMissing);
        console.log(
            'Warnings:',
            warnings.length ? warnings : '(none)'
        );
        logSection('Repository Artifact Resolution Summary');

        return {
            selectedMetadata: applyEnrichmentToCollection(
                selectedMetadata,
                enrichmentByKey
            ),
            discoveredRelationships: applyEnrichmentToCollection(
                discoveredRelationships,
                enrichmentByKey
            ),
            discoveredReferences: applyEnrichmentToCollection(
                discoveredReferences,
                enrichmentByKey
            ),
            enrichedDependencies: applyEnrichmentToCollection(
                enrichedDependencies,
                enrichmentByKey
            ),
            resolvedNodes,
            summary
        };
    };

    try {
        if (Array.isArray(repoFiles)) {
            return runResolution(repoFiles);
        }

        return await withRepositoryIndex(
            { repoUrl, branch: sourceBranch },
            runResolution
        );
    } catch (error) {
        const warnings = [
            error?.message ||
                'Repository artifact resolution failed; continuing without artifact paths.'
        ];

        console.log(warnings[0]);
        logSection('Repository Artifact Resolution Summary');

        return {
            ...emptyResult,
            summary: { ...emptyResult.summary, warnings }
        };
    }
}

module.exports = {
    resolveRepositoryArtifacts,
    collectGraphNodes,
    enrichNode
};
