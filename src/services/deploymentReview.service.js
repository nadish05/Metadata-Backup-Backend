const dependencyAnalyzer = require('./deploymentReview/dependencyAnalyzer.service');
const apiVersionValidator = require('./apiVersionValidator.service');
const testClassValidator = require('./testClassValidator.service');
const coverageValidator = require('./coverageValidator.service');
const readinessCalculator = require('./readinessCalculator.service');

async function runDeploymentReview({ metadataType, filePath, workspace }) {
    const dependencyAnalysis = await dependencyAnalyzer.analyzeDependencies(
        metadataType,
        filePath,
        workspace
    );

    const apiValidation = await apiVersionValidator.validateApiVersion(
        metadataType,
        filePath,
        workspace
    );

    const testValidation = await testClassValidator.findTestClasses(
        metadataType,
        filePath,
        workspace
    );

    const coverageValidation = await coverageValidator.validateCoverage(
        metadataType,
        filePath,
        workspace
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
