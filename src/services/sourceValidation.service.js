const sourceOrgConnection = require('./sourceValidation/sourceOrgConnection.service');
const testRunner = require('./sourceValidation/testRunner.service');
const coverageParser = require('./sourceValidation/coverageParser.service');
const coverageValidation = require('./sourceValidation/coverageValidation.service');
const metadataSelection = require('./sourceValidation/metadataSelection.service');

const VALIDATION_STAGE = 'SOURCE_VALIDATION';

function resolveSelectedTestClassNames(deploymentPackage) {
    const selectedTestClasses =
        deploymentPackage?.selectedTestClasses;

    if (!Array.isArray(selectedTestClasses)) {
        return [];
    }

    return selectedTestClasses
        .map((testClass) => {
            if (typeof testClass === 'string') {
                return testClass;
            }

            return testClass?.name;
        })
        .filter(Boolean);
}

async function runSourceValidation({
    refreshToken,
    instanceUrl,
    orgId,
    deploymentPackage
}) {
    const testClassNames = resolveSelectedTestClassNames(deploymentPackage);
    const { apexClasses, ignoredMetadata } =
        metadataSelection.resolveSelectedMetadata(deploymentPackage);

    const alias = await sourceOrgConnection.connectToSourceOrg({
        refreshToken,
        instanceUrl
    });

    const executionResult = await testRunner.executeTestsWithResults(
        testClassNames,
        alias
    );

    const normalizedCoverage = coverageParser.parseCoverageFromTestResult(
        executionResult.testResult
    );

    const coverageValidationResult = coverageValidation.validateCoverage(
        normalizedCoverage,
        apexClasses
    );

    return {
        success: true,
        validationStage: VALIDATION_STAGE,
        sourceValidation: {
            validationTime: new Date().toISOString(),
            overallStatus: executionResult.overallStatus,
            testRunId: executionResult.testRunId,
            executionTime: executionResult.executionTime,
            results: executionResult.results
        },
        coverageValidation: {
            ...coverageValidationResult,
            ignoredMetadata
        }
    };
}

module.exports = {
    runSourceValidation
};
