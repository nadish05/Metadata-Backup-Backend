const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const {
    isStructuralActionOverrideFlexiPageDependency,
    discoverStructuralActionOverrideRelatedLists
} = require('./structuralActionOverrideRelatedList.discoverer');
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
        `related-list-closure-${Date.now()}`
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
 * Discover bounded related-list CustomField / CustomObject prerequisites from
 * structural actionOverride FlexiPages.
 */
async function discoverStructuralActionOverrideRelatedListClosure({
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
        return discoverStructuralActionOverrideRelatedLists({
            structuralFlexiPageDependencies,
            readRepoFile,
            repoFiles: repoFiles || []
        });
    }

    if (!repoUrl || !sourceBranch) {
        return {
            dependencies: [],
            closureCandidates: [],
            warnings: [
                'Repository context unavailable for structural action override related list discovery.'
            ],
            filesScanned: 0
        };
    }

    return withClonedRepository({ repoUrl, sourceBranch }, (repoContext) =>
        discoverStructuralActionOverrideRelatedLists({
            structuralFlexiPageDependencies,
            readRepoFile: repoContext.readRepoFile,
            repoFiles: repoContext.repoFiles
        })
    );
}

module.exports = {
    discoverStructuralActionOverrideRelatedListClosure,
    filterStructuralActionOverrideFlexiPages,
    mergeUniqueDependencies
};
