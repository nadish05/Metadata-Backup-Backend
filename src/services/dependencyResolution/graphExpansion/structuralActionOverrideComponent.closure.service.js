const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const {
    isStructuralActionOverrideFlexiPageDependency,
    discoverStructuralActionOverrideComponents
} = require('./structuralActionOverrideComponent.discoverer');
const {
    discoverStructuralActionOverrideApexClasses
} = require('./structuralActionOverrideApex.discoverer');
const {
    mergeUniqueDependencies
} = require('./structuralFormulaRelatedField.closure.service');

const execAsync = util.promisify(exec);

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function filterStructuralActionOverrideFlexiPages(dependencies = []) {
    return (dependencies || []).filter(
        isStructuralActionOverrideFlexiPageDependency
    );
}

async function withClonedRepository({ repoUrl, sourceBranch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = path.join(
        os.tmpdir(),
        `lwc-closure-${Date.now()}`
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

async function discoverBoundedLwcApexPrerequisites({
    readRepoFile,
    repoFiles,
    structuralFlexiPageDependencies
}) {
    const componentResult = await discoverStructuralActionOverrideComponents({
        structuralFlexiPageDependencies,
        readRepoFile,
        repoFiles: repoFiles || []
    });

    const apexResult = await discoverStructuralActionOverrideApexClasses({
        structuralComponentDependencies: componentResult.dependencies,
        readRepoFile,
        repoFiles: repoFiles || []
    });

    return {
        dependencies: [
            ...(componentResult.dependencies || []),
            ...(apexResult.dependencies || [])
        ],
        closureCandidates: [
            ...(componentResult.closureCandidates || []),
            ...(apexResult.closureCandidates || [])
        ],
        warnings: [
            ...(componentResult.warnings || []),
            ...(apexResult.warnings || [])
        ],
        filesScanned:
            (componentResult.filesScanned || 0) +
            (apexResult.filesScanned || 0)
    };
}

/**
 * Discover bounded LWC → Apex prerequisite closure from structural
 * actionOverride FlexiPages.
 */
async function discoverStructuralActionOverrideComponentClosure({
    enrichedDependencies = [],
    repoUrl,
    sourceBranch,
    readRepoFile = null,
    repoFiles = null
} = {}) {
    const structuralFlexiPageDependencies =
        filterStructuralActionOverrideFlexiPages(enrichedDependencies);

    if (!structuralFlexiPageDependencies.length) {
        return {
            dependencies: [],
            closureCandidates: [],
            warnings: [],
            filesScanned: 0
        };
    }

    if (readRepoFile) {
        return discoverBoundedLwcApexPrerequisites({
            readRepoFile,
            repoFiles: repoFiles || [],
            structuralFlexiPageDependencies
        });
    }

    if (!repoUrl || !sourceBranch) {
        return {
            dependencies: [],
            closureCandidates: [],
            warnings: [
                'Repository context unavailable for structural action override component discovery.'
            ],
            filesScanned: 0
        };
    }

    return withClonedRepository({ repoUrl, sourceBranch }, (repoContext) =>
        discoverBoundedLwcApexPrerequisites({
            readRepoFile: repoContext.readRepoFile,
            repoFiles: repoContext.repoFiles,
            structuralFlexiPageDependencies
        })
    );
}

module.exports = {
    discoverStructuralActionOverrideComponentClosure,
    discoverBoundedLwcApexPrerequisites,
    filterStructuralActionOverrideFlexiPages,
    mergeUniqueDependencies
};
