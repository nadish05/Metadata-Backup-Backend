const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const dependencyAnalyzer = require('./deploymentReview/dependencyAnalyzer.service');
const apiVersionValidator = require('./apiVersionValidator.service');
const testClassValidator = require('./testClassValidator.service');
const coverageValidator = require('./coverageValidator.service');
const readinessCalculator = require('./readinessCalculator.service');

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

async function runDeploymentReview({
    metadataType,
    repoUrl,
    branch,
    filePath,
    destinationOrgId
}) {
    return withClonedRepository({ repoUrl, branch }, async (readRepoFile, listRepoFiles) => {
        const content = await readRepoFile(filePath);

        const currentClassName = dependencyAnalyzer.getCurrentClassName(
            content,
            filePath
        );

        const dependencyAnalysis = dependencyAnalyzer.analyzeApexContent(
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

        const coverageValidation = await coverageValidator.validateCoverage(
            metadataType,
            filePath,
            destinationOrgId,
            testValidation
        );

        const deploymentReadiness = await readinessCalculator.calculateReadiness({
            dependencyAnalysis,
            apiValidation,
            testValidation,
            coverageValidation
        });

        return {
            success: true,
            dependencyAnalysis,
            apiValidation,
            testValidation,
            coverageValidation,
            deploymentReadiness
        };
    });
}

module.exports = {
    runDeploymentReview
};
