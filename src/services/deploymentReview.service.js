const util = require('util');
const path = require('path');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const dependencyAnalyzer = require('./deploymentReview/dependencyAnalyzer.service');
const dependencySelection = require('./dependencySelection.service');
const apiVersionValidator = require('./apiVersionValidator.service');
const testClassValidator = require('./testClassValidator.service');

const SUPPORTED_METADATA_TYPE = 'ApexClass';

function getMetadataName(filePath) {
    return path.basename(filePath, path.extname(filePath));
}

function normalizeSelectedMetadata(selectedMetadata) {
    if (!Array.isArray(selectedMetadata)) {
        return [];
    }

    return selectedMetadata
        .filter((item) => item?.filePath)
        .map((item) => ({
            metadataType: item.metadataType || null,
            filePath: item.filePath
        }));
}

function normalizeDeploymentPackage(payload) {
    if (Array.isArray(payload.selectedMetadata)) {
        return {
            comparisonId: payload.comparisonId || null,
            repoUrl: payload.repoUrl,
            sourceBranch: payload.sourceBranch || null,
            destinationBranch: payload.destinationBranch,
            selectedMetadata: normalizeSelectedMetadata(payload.selectedMetadata)
        };
    }

    if (payload.filePath) {
        return {
            comparisonId: null,
            repoUrl: payload.repoUrl,
            sourceBranch: null,
            destinationBranch: payload.destinationBranch || payload.branch,
            selectedMetadata: [
                {
                    metadataType: payload.metadataType || SUPPORTED_METADATA_TYPE,
                    filePath: payload.filePath
                }
            ]
        };
    }

    return {
        comparisonId: payload.comparisonId || null,
        repoUrl: payload.repoUrl,
        sourceBranch: payload.sourceBranch || null,
        destinationBranch: payload.destinationBranch || payload.branch,
        selectedMetadata: []
    };
}

async function withClonedRepository({ repoUrl, branch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = `/tmp/deployment-review-${Date.now()}`;

    const authenticatedUrl = repoUrl.replace(
        'https://',
        `https://${githubToken}@`
    );

    try {
        await execAsync(
            `git clone ${authenticatedUrl} ${repoPath}`
        );

        await execAsync(
            `cd ${repoPath} && git fetch --all`
        );

        const readRepoFile = async (targetPath) => {
            const fileContent = await execAsync(
                `cd ${repoPath} && git show origin/${branch}:"${targetPath}"`
            );

            return fileContent.stdout;
        };

        const listRepoFiles = async () => {
            const result = await execAsync(
                `cd ${repoPath} && git ls-tree -r --name-only origin/${branch}`
            );

            return result.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);
        };

        return await callback(readRepoFile, listRepoFiles);
    } finally {
        await execAsync(
            `rm -rf ${repoPath}`
        );
    }
}

async function reviewSingleMetadataItem({
    metadataType,
    filePath,
    readRepoFile,
    listRepoFiles
}) {
    const content = await readRepoFile(filePath);

    const currentClassName = dependencyAnalyzer.getCurrentClassName(
        content,
        filePath
    );

    const rawDependencyAnalysis = dependencyAnalyzer.analyzeApexContent(
        content,
        currentClassName
    );

    const apiValidation = await apiVersionValidator.validateApiVersion(
        metadataType,
        filePath,
        readRepoFile
    );

    const testValidation = await testClassValidator.findTestClasses(
        metadataType,
        filePath,
        readRepoFile,
        listRepoFiles
    );

    const dependencyAnalysis = dependencySelection.buildDependencySelection(
        rawDependencyAnalysis,
        testValidation
    );

    return {
        dependencyAnalysis,
        apiValidation,
        testValidation
    };
}

function buildNotSupportedResult({ metadataType, filePath }) {
    return {
        metadataType,
        metadataName: getMetadataName(filePath),
        filePath,
        status: 'NOT_SUPPORTED_YET'
    };
}

async function processMetadataItem(item, readRepoFile, listRepoFiles) {
    const { metadataType, filePath } = item;
    const metadataName = getMetadataName(filePath);

    if (metadataType !== SUPPORTED_METADATA_TYPE) {
        return buildNotSupportedResult({ metadataType, filePath });
    }

    try {
        const reviewResult = await reviewSingleMetadataItem({
            metadataType,
            filePath,
            readRepoFile,
            listRepoFiles
        });

        return {
            metadataType,
            metadataName,
            filePath,
            status: 'SUCCESS',
            ...reviewResult
        };
    } catch (error) {
        return {
            metadataType,
            metadataName,
            filePath,
            status: 'FAILED',
            error:
                error.stderr ||
                error.stdout ||
                error.message
        };
    }
}

async function runDeploymentReview(payload) {
    const deploymentPackage = normalizeDeploymentPackage(payload);
    const { repoUrl, destinationBranch, selectedMetadata } = deploymentPackage;

    if (!repoUrl || !destinationBranch) {
        throw new Error('repoUrl and destinationBranch are required');
    }

    if (!selectedMetadata.length) {
        return {
            success: true,
            deploymentReview: []
        };
    }

    const hasSupportedMetadata = selectedMetadata.some(
        (item) => item.metadataType === SUPPORTED_METADATA_TYPE
    );

    if (!hasSupportedMetadata) {
        return {
            success: true,
            deploymentReview: selectedMetadata.map((item) =>
                buildNotSupportedResult(item)
            )
        };
    }

    return withClonedRepository(
        { repoUrl, branch: destinationBranch },
        async (readRepoFile, listRepoFiles) => {
            const deploymentReview = [];

            for (const item of selectedMetadata) {
                const result = await processMetadataItem(
                    item,
                    readRepoFile,
                    listRepoFiles
                );

                deploymentReview.push(result);
            }

            return {
                success: true,
                deploymentReview
            };
        }
    );
}

module.exports = {
    runDeploymentReview,
    reviewSingleMetadataItem
};
