const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const {
    getRegisteredReferenceDiscoverers
} = require('./referenceRegistry');
const { buildGraphNodeId } = require('./graphId');

const execAsync = util.promisify(exec);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function collectLayoutScanTargets({
    selectedMetadata,
    discoveredRelationships,
    enrichedDependencies
}) {
    const targets = [];
    const seen = new Set();

    function addTarget(item, depth = 1) {
        const metadataType = item?.metadataType || item?.type;
        const name = item?.metadataName || item?.name;

        if (metadataType !== 'Layout' || !name) {
            return;
        }

        const key = buildGraphNodeId('Layout', name);

        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        targets.push({
            metadataType: 'Layout',
            metadataName: name,
            name,
            filePath: item.filePath || null,
            depth: item.depth != null ? item.depth : depth
        });
    }

    for (const item of selectedMetadata || []) {
        addTarget(item, 0);
    }

    for (const item of discoveredRelationships || []) {
        addTarget(item, item.depth || 1);
    }

    for (const item of enrichedDependencies || []) {
        addTarget(item, item.depth || 1);
    }

    return targets;
}

function collectFlexiPageScanTargets({
    selectedMetadata,
    discoveredRelationships,
    enrichedDependencies
}) {
    const targets = [];
    const seen = new Set();

    function addTarget(item, depth = 1) {
        const metadataType = item?.metadataType || item?.type;
        const name = item?.metadataName || item?.name;

        if (metadataType !== 'FlexiPage' || !name) {
            return;
        }

        const key = buildGraphNodeId('FlexiPage', name);

        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        targets.push({
            metadataType: 'FlexiPage',
            metadataName: name,
            name,
            filePath: item.filePath || null,
            depth: item.depth != null ? item.depth : depth
        });
    }

    for (const item of selectedMetadata || []) {
        addTarget(item, 0);
    }

    for (const item of discoveredRelationships || []) {
        addTarget(item, item.depth || 1);
    }

    for (const item of enrichedDependencies || []) {
        addTarget(item, item.depth || 1);
    }

    return targets;
}

function buildReferenceSummary(references, warnings = []) {
    const byType = {};

    for (const reference of references) {
        const type = reference.referenceType || reference.metadataType || 'Unknown';
        byType[type] = (byType[type] || 0) + 1;
    }

    return {
        referencesDiscovered: references.length,
        byType,
        blockingReferences: references.filter((item) => item.blocking).length,
        deployableReferences: references.filter((item) => item.deployable)
            .length,
        warnings: [...warnings]
    };
}

function logReferenceDiscovery(references, summary, metadataScanned) {
    console.log('Metadata scanned:', metadataScanned);
    console.log('References discovered:', summary.referencesDiscovered);

    for (const reference of references) {
        console.log('Reference type:', reference.referenceType);
        console.log('Source metadata:', reference.sourceMetadata);
        console.log('Target metadata:', `${reference.metadataType}:${reference.name}`);
        console.log('Reason:', reference.reason);
        console.log('------------------------------------');
    }

    console.log('Summary:');
    console.log('Blocking references:', summary.blockingReferences);
    console.log('Deployable references:', summary.deployableReferences);
    console.log(
        'Warnings:',
        summary.warnings.length ? summary.warnings : '(none)'
    );

    logSection('Metadata Reference Discovery Summary');
}

async function withClonedRepository({ repoUrl, branch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = path.join(
        os.tmpdir(),
        `reference-discovery-${Date.now()}`
    );

    const authenticatedUrl =
        githubToken && repoUrl?.startsWith('https://')
            ? repoUrl.replace('https://', `https://${githubToken}@`)
            : repoUrl;

    try {
        await execAsync(
            `git clone ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );
        await execAsync(`cd ${shellQuote(repoPath)} && git fetch --all`);

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
            // Cleanup best-effort.
        }
    }
}

/**
 * Discover internal metadata references (FlexiPage fields, components, etc.).
 * Discovery only — does not modify packaging or deployment decisions.
 */
async function discoverReferences({
    selectedMetadata,
    discoveredRelationships,
    enrichedDependencies,
    repoUrl,
    sourceBranch
} = {}) {
    logSection('Metadata Reference Discovery');

    const emptySummary = buildReferenceSummary([]);

    if (!repoUrl || !sourceBranch) {
        const warnings = [
            'Repository URL or source branch not provided; reference discovery skipped.'
        ];
        console.log('Metadata scanned: 0');
        console.log('References discovered: 0');
        console.log('Warnings:', warnings);
        logSection('Metadata Reference Discovery Summary');

        return {
            discoveredReferences: [],
            referenceSummary: buildReferenceSummary([], warnings)
        };
    }

    const scanTargets = [
        ...collectFlexiPageScanTargets({
            selectedMetadata,
            discoveredRelationships,
            enrichedDependencies
        }),
        ...collectLayoutScanTargets({
            selectedMetadata,
            discoveredRelationships,
            enrichedDependencies
        })
    ];

    if (!scanTargets.length) {
        console.log('Metadata scanned: 0');
        console.log('References discovered: 0');
        logSection('Metadata Reference Discovery Summary');

        return {
            discoveredReferences: [],
            referenceSummary: emptySummary
        };
    }

    const discoverers = getRegisteredReferenceDiscoverers();

    try {
        return await withClonedRepository(
            { repoUrl, branch: sourceBranch },
            async (readRepoFile, listRepoFiles) => {
                const repoFiles = await listRepoFiles();
                const references = [];
                const warnings = [];
                let metadataScanned = 0;
                let filesScanned = 0;

                for (const discoverer of discoverers) {
                    const result = await discoverer.discover({
                        selectedMetadata: scanTargets,
                        repoFiles,
                        readRepoFile
                    });

                    references.push(...(result.references || []));
                    warnings.push(...(result.warnings || []));
                    metadataScanned += result.metadataScanned || 0;
                    filesScanned += result.filesScanned || 0;
                }

                const deduped = [];
                const seen = new Set();

                for (const reference of references) {
                    const key =
                        reference.id ||
                        buildGraphNodeId(
                            reference.metadataType,
                            reference.name
                        );

                    if (!key || seen.has(key)) {
                        continue;
                    }

                    seen.add(key);
                    deduped.push(reference);
                }

                const referenceSummary = buildReferenceSummary(
                    deduped,
                    warnings
                );

                logReferenceDiscovery(
                    deduped,
                    referenceSummary,
                    metadataScanned
                );

                return {
                    discoveredReferences: deduped,
                    referenceSummary,
                    filesScanned
                };
            }
        );
    } catch (error) {
        const warnings = [
            error?.message ||
                'Reference discovery failed; continuing without references.'
        ];

        console.log('Metadata scanned: 0');
        console.log('References discovered: 0');
        console.log('Warnings:', warnings);
        logSection('Metadata Reference Discovery Summary');

        return {
            discoveredReferences: [],
            referenceSummary: buildReferenceSummary([], warnings)
        };
    }
}

module.exports = {
    discoverReferences
};
