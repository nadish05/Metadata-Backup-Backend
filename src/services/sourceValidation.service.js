const sourceOrgConnection = require('./sourceValidation/sourceOrgConnection.service');
const testRunner = require('./sourceValidation/testRunner.service');

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
    const alias = await sourceOrgConnection.connectToSourceOrg({
        refreshToken,
        instanceUrl
    });

    const executionResult = await testRunner.executeTestsWithResults(
        testClassNames,
        alias
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
        }
    };
}

module.exports = {
    runSourceValidation
};
