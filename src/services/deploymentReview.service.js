const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const dependencyAnalyzer = require('./deploymentReview/dependencyAnalyzer.service');
const apiVersionValidator = require('./apiVersionValidator.service');
const testClassValidator = require('./testClassValidator.service');
const coverageValidator = require('./coverageValidator.service');
const readinessCalculator = require('./readinessCalculator.service');

async function readFileFromGitHub({ repoUrl, branch, filePath }) {
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

        const fileContent = await execAsync(
            `cd ${repoPath} && git show origin/${branch}:"${filePath}"`
        );

        return fileContent.stdout;
    } finally {
        await execAsync(
            `rm -rf ${repoPath}`
        );
    }
}

async function runDeploymentReview({ metadataType, repoUrl, branch, filePath }) {
    const content = await readFileFromGitHub({
        repoUrl,
        branch,
        filePath
    });

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
        repoUrl,
        branch
    );

    const testValidation = await testClassValidator.findTestClasses(
        metadataType,
        filePath,
        repoUrl,
        branch
    );

    const coverageValidation = await coverageValidator.validateCoverage(
        metadataType,
        filePath,
        repoUrl,
        branch
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
}

module.exports = {
    runDeploymentReview
};
