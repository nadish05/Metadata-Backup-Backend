const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const {
    DISCOVERY_METHOD: STRUCTURAL_ACTION_OVERRIDE_FIELD_DISCOVERY_METHOD
} = require('./structuralActionOverrideField.discoverer');
const {
    discoverStructuralFormulaRelatedFields
} = require('./structuralFormulaRelatedField.discoverer');

const execAsync = util.promisify(exec);

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function filterStructuralActionOverrideFields(dependencies = []) {
    return (dependencies || []).filter(
        (dependency) =>
            (dependency?.type === 'CustomField' ||
                dependency?.metadataType === 'CustomField') &&
            dependency?.discoveryMethod ===
                STRUCTURAL_ACTION_OVERRIDE_FIELD_DISCOVERY_METHOD
    );
}

function mergeUniqueDependencies(existingDependencies = [], discovered = []) {
    const merged = [...(existingDependencies || [])];
    const keys = new Set(
        merged.map(
            (item) =>
                `${item?.type || item?.metadataType}:${item?.name || item?.metadataName}`
        )
    );

    for (const dependency of discovered || []) {
        const key = `${dependency?.type || dependency?.metadataType}:${dependency?.name || dependency?.metadataName}`;

        if (!key || keys.has(key)) {
            continue;
        }

        keys.add(key);
        merged.push(dependency);
    }

    return merged;
}

async function withClonedRepository({ repoUrl, sourceBranch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = path.join(
        os.tmpdir(),
        `formula-closure-${Date.now()}`
    );

    const authenticatedUrl =
        githubToken && repoUrl?.startsWith('https://')
            ? repoUrl.replace('https://', `https://${githubToken}@`)
            : repoUrl;

    try {
        await execAsync(
            `git clone --branch ${shellQuote(sourceBranch)} --single-branch ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );

        const readRepoFile = async (targetPath) => {
            const result = await execAsync(
                `cd ${shellQuote(repoPath)} && git show HEAD:${shellQuote(targetPath)}`
            );

            return result.stdout;
        };

        const listResult = await execAsync(
            `cd ${shellQuote(repoPath)} && git ls-tree -r --name-only HEAD`
        );
        const repoFiles = String(listResult.stdout || '')
            .split(/\r?\n/)
            .filter(Boolean);

        return await callback({ readRepoFile, repoFiles });
    } finally {
        try {
            await execAsync(`rm -rf ${shellQuote(repoPath)}`);
        } catch (error) {
            try {
                await execAsync(
                    `powershell -NoProfile -Command "Remove-Item -LiteralPath ${shellQuote(repoPath)} -Recurse -Force"`
                );
            } catch (cleanupError) {
                // Best-effort cleanup only.
            }
        }
    }
}

/**
 * Discover bounded formula-related CustomField closure prerequisites from
 * structurally required formula fields.
 */
async function discoverStructuralFormulaRelatedFieldClosure({
    enrichedDependencies = [],
    repoUrl,
    sourceBranch,
    readRepoFile = null,
    repoFiles = null
} = {}) {
    const structuralFieldDependencies = filterStructuralActionOverrideFields(
        enrichedDependencies
    );

    if (!structuralFieldDependencies.length) {
        return {
            dependencies: [],
            closureCandidates: [],
            warnings: [],
            filesScanned: 0
        };
    }

    if (readRepoFile) {
        return discoverStructuralFormulaRelatedFields({
            structuralFieldDependencies,
            readRepoFile,
            repoFiles: repoFiles || []
        });
    }

    if (!repoUrl || !sourceBranch) {
        return {
            dependencies: [],
            closureCandidates: [],
            warnings: [
                'Repository context unavailable for structural formula related field discovery.'
            ],
            filesScanned: 0
        };
    }

    return withClonedRepository({ repoUrl, sourceBranch }, (repoContext) =>
        discoverStructuralFormulaRelatedFields({
            structuralFieldDependencies,
            readRepoFile: repoContext.readRepoFile,
            repoFiles: repoContext.repoFiles
        })
    );
}

module.exports = {
    discoverStructuralFormulaRelatedFieldClosure,
    filterStructuralActionOverrideFields,
    mergeUniqueDependencies
};
