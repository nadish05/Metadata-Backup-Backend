const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const { getRegisteredDiscoverers } = require('./relationshipRegistry');

const execAsync = util.promisify(exec);

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
    const name = dependency?.name;

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
        type: relationship.metadataType || 'CustomObject',
        metadataType: relationship.metadataType || 'CustomObject',
        relationship: relationship.relationship,
        required: relationship.required !== false,
        selected: relationship.selected !== false,
        discoveredBy: relationship.discoveredBy,
        sourceMetadata: relationship.sourceMetadata,
        sourceField: relationship.sourceField,
        discoveryMethod: relationship.discoveryMethod,
        reason: relationship.reason
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

            // Enrich provenance without changing existing discovery entries.
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

function logDiscoveryResults(relationships, summary) {
    console.log('Selected metadata scanned:', summary.metadataScanned);
    console.log('Files scanned:', summary.filesScanned);
    console.log('Relationships discovered:', summary.relationshipsDiscovered);

    for (const relationship of relationships) {
        console.log('Relationship');
        console.log(relationship.relationship);
        console.log(
            `${relationship.sourceMetadata}.${relationship.sourceField}`
        );
        console.log('↓');
        console.log(relationship.name);
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
            summary
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
            summary: emptySummary
        };
    }

    const discoverers = getRegisteredDiscoverers();

    try {
        return await withClonedRepository(
            { repoUrl, branch: sourceBranch },
            async (readRepoFile, listRepoFiles) => {
                const repoFiles = await listRepoFiles();
                const relationships = [];
                const warnings = [];
                let metadataScanned = 0;
                let filesScanned = 0;

                for (const discoverer of discoverers) {
                    const result = await discoverer.discover({
                        selectedMetadata,
                        repoFiles,
                        readRepoFile
                    });

                    relationships.push(...(result.relationships || []));
                    warnings.push(...(result.warnings || []));
                    metadataScanned += result.metadataScanned || 0;
                    filesScanned += result.filesScanned || 0;
                }

                const summary = buildSummary({
                    metadataScanned,
                    filesScanned,
                    relationships,
                    warnings
                });

                logDiscoveryResults(relationships, summary);

                return {
                    discoveredRelationships: relationships,
                    enrichedDependencies: mergeDependencies(
                        existingDependencies,
                        relationships
                    ),
                    summary
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
            summary
        };
    }
}

module.exports = {
    discoverRelationships
};
