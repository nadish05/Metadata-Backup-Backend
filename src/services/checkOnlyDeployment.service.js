const axios = require('axios');
const util = require('util');
const path = require('path');
const { exec } = require('child_process');

const { parseCoverageFromTestResult } = require('./sourceValidation/coverageParser.service');
const {
    getCliCompatibility,
    buildCliCompatibilityDiagnostics
} = require('./salesforceCliCompatibility.service');
const { ensureSfdxProject } = require('./sfdxProject.service');

const execAsync = util.promisify(exec);

const EMPTY_TEST_RESULTS = {
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    failingTests: []
};

const EMPTY_CODE_COVERAGE = {
    overallCoverage: 0
};

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function withCliCompatibility(result, cliCompatibility) {
    if (!cliCompatibility) {
        return result;
    }

    return {
        ...result,
        cliCompatibility
    };
}

function resolveValidationCapabilityMessage(compatibility) {
    if (compatibility?.failureReason === 'unsupported') {
        return 'Installed Salesforce CLI does not support deployment validation.';
    }

    return 'Unable to determine Salesforce CLI deployment validation capabilities.';
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function parseCliJson(output) {
    if (!output) {
        throw new Error('No JSON output from Salesforce CLI');
    }

    const start = output.indexOf('{');

    if (start === -1) {
        throw new Error('No JSON output from Salesforce CLI');
    }

    return JSON.parse(output.slice(start));
}

function resolveErrorMessage(error) {
    const oauthError = error.response?.data;

    if (oauthError?.error === 'invalid_grant') {
        return 'Refresh token is expired or invalid.';
    }

    if (oauthError?.error === 'invalid_client') {
        return 'Invalid Salesforce client credentials.';
    }

    if (oauthError?.error_description) {
        return oauthError.error_description;
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return 'Unable to reach Salesforce. Network connection failed.';
    }

    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return 'Salesforce request timed out.';
    }

    if (error.response?.status >= 500) {
        return 'Salesforce is currently unavailable.';
    }

    if (error.response?.status === 401) {
        return 'Unable to authenticate with destination org.';
    }

    return error.message || 'Check-only deployment validation failed.';
}

async function refreshAccessToken(refreshToken) {
    const tokenResponse = await axios.post(
        'https://login.salesforce.com/services/oauth2/token',
        null,
        {
            params: {
                grant_type: 'refresh_token',
                client_id: process.env.SF_CLIENT_ID,
                client_secret: process.env.SF_CLIENT_SECRET,
                refresh_token: refreshToken
            },
            timeout: 15000
        }
    );

    return {
        accessToken: tokenResponse.data.access_token,
        instanceUrl: tokenResponse.data.instance_url
    };
}

async function loginSfOrg(accessToken, instanceUrl, alias) {
    const loginCommand =
        `export SF_ACCESS_TOKEN="${accessToken}" && ` +
        `sf org login access-token ` +
        `-r ${instanceUrl} ` +
        `--alias ${alias} ` +
        `--no-prompt`;

    await execAsync(loginCommand);
}

function isWorkspaceReady(generatedWorkspace) {
    return (
        generatedWorkspace?.workspaceCreated === true &&
        generatedWorkspace?.packageXmlWritten === true &&
        generatedWorkspace?.status === 'READY'
    );
}

function validateWorkspace(generatedWorkspace) {
    logSection('Workspace Validation');

    if (!isWorkspaceReady(generatedWorkspace)) {
        return {
            ready: false,
            message: 'Deployment workspace is not ready.'
        };
    }

    return {
        ready: true,
        workspacePath: generatedWorkspace.workspacePath
    };
}

function toNumber(value) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
}

function isDebugEnabled() {
    return process.env.DEPLOYMENT_DEBUG === 'true';
}

function resolveExecutionMode(deploymentValidationFlag) {
    if (deploymentValidationFlag === '--dry-run') {
        return 'dry-run';
    }

    if (deploymentValidationFlag === '--check-only') {
        return 'check-only';
    }

    return null;
}

function formatElapsedDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        return null;
    }

    if (milliseconds < 1000) {
        return `${Math.round(milliseconds)}ms`;
    }

    const totalSeconds = Math.round(milliseconds / 1000);

    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}m ${seconds}s`;
}

function formatDuration(startTime, endTime, elapsedMs) {
    if (startTime && endTime) {
        const milliseconds = new Date(endTime) - new Date(startTime);

        if (Number.isFinite(milliseconds) && milliseconds >= 0) {
            return formatElapsedDuration(milliseconds);
        }
    }

    if (elapsedMs != null) {
        return formatElapsedDuration(elapsedMs);
    }

    return null;
}

function buildDeploymentSummary({
    deployResult,
    componentSuccesses,
    componentFailures,
    testResults,
    codeCoverage,
    mode = 'validation'
}) {
    const summary = {
        testsRun: testResults?.testsRun || 0,
        testsFailed: testResults?.testsFailed || 0,
        overallCoverage: codeCoverage?.overallCoverage || 0,
        deploymentStatus: deployResult?.status || 'Unknown'
    };

    if (mode === 'execution') {
        return {
            componentsDeployed: componentSuccesses,
            componentsFailed: componentFailures,
            ...summary
        };
    }

    return {
        componentsValidated: componentSuccesses,
        componentsFailed: componentFailures,
        ...summary
    };
}

function applyCliDiagnostics(result, { cliStdout, cliStderr } = {}) {
    if (!isDebugEnabled()) {
        return result;
    }

    return {
        ...result,
        cliStdout: cliStdout || '',
        cliStderr: cliStderr || ''
    };
}

function mapComponentFailure(failure) {
    return {
        componentName:
            failure.fullName ||
            failure.componentName ||
            failure.fileName ||
            null,
        metadataType: failure.componentType || failure.type || null,
        problem:
            failure.problem ||
            failure.problemType ||
            failure.message ||
            null,
        file: failure.fileName || failure.filePath || null,
        line: failure.lineNumber ?? failure.line ?? null,
        column: failure.columnNumber ?? failure.column ?? null
    };
}

function mapFailureDetails(componentFailures) {
    if (!Array.isArray(componentFailures)) {
        return [];
    }

    return componentFailures.map(mapComponentFailure);
}

function mapFailingTests(failures) {
    if (!Array.isArray(failures)) {
        return [];
    }

    return failures.map((failure) => ({
        className: failure.name || failure.className || null,
        methodName: failure.methodName || null,
        message: failure.message || failure.stackTrace || null
    }));
}

function calculateOverallCoverage(runTestResult, deployCoverage) {
    const coverageEntries = [];

    if (Array.isArray(runTestResult?.codeCoverage)) {
        for (const entry of runTestResult.codeCoverage) {
            if (entry?.name == null) {
                continue;
            }

            const numLocations = toNumber(entry.numLocations);
            const numLocationsNotCovered = toNumber(
                entry.numLocationsNotCovered
            );

            if (numLocations > 0) {
                coverageEntries.push({
                    className: entry.name,
                    coverage: Math.round(
                        ((numLocations - numLocationsNotCovered) /
                            numLocations) *
                            100
                    )
                });
            }
        }
    }

    if (!coverageEntries.length && Array.isArray(deployCoverage)) {
        for (const entry of deployCoverage) {
            if (entry?.name != null && entry?.coveredPercent != null) {
                coverageEntries.push({
                    className: entry.name,
                    coverage: Math.round(entry.coveredPercent)
                });
            }
        }
    }

    if (!coverageEntries.length) {
        return { ...EMPTY_CODE_COVERAGE };
    }

    const overallCoverage = Math.round(
        coverageEntries.reduce((sum, entry) => sum + entry.coverage, 0) /
            coverageEntries.length
    );

    return {
        overallCoverage,
        classes: coverageEntries
    };
}

function mapTestResults(runTestResult) {
    if (!runTestResult || typeof runTestResult !== 'object') {
        return { ...EMPTY_TEST_RESULTS };
    }

    const testsRun = toNumber(runTestResult.numTestsRun);
    const testsFailed = toNumber(runTestResult.numFailures);
    const testsPassed = Math.max(testsRun - testsFailed, 0);

    return {
        testsRun,
        testsPassed,
        testsFailed,
        failingTests: mapFailingTests(runTestResult.failures)
    };
}

function mapWarnings(details, cliJson) {
    const warnings = [];

    if (Array.isArray(details?.componentSuccesses)) {
        for (const success of details.componentSuccesses) {
            if (success.warning) {
                warnings.push(success.warning);
            }
        }
    }

    if (Array.isArray(runTestResultWarnings(details))) {
        warnings.push(...runTestResultWarnings(details));
    }

    if (Array.isArray(cliJson?.warnings)) {
        warnings.push(
            ...cliJson.warnings.map((warning) =>
                typeof warning === 'string'
                    ? warning
                    : warning.message || JSON.stringify(warning)
            )
        );
    }

    return [...new Set(warnings.filter(Boolean))];
}

function runTestResultWarnings(details) {
    return details?.runTestResult?.codeCoverageWarnings || [];
}

function mapDeployStatus(deployResult) {
    if (deployResult?.success === true) {
        return 'SUCCESS';
    }

    if (
        deployResult?.status === 'Succeeded' ||
        deployResult?.status === 'SucceededPartial'
    ) {
        return deployResult.status === 'Succeeded' ? 'SUCCESS' : 'FAILED';
    }

    return 'FAILED';
}

function mapDeployOutcome({
    cliJson,
    cliStdout,
    cliStderr,
    elapsedMs,
    cliCommand,
    cliVersion,
    executionMode,
    mode = 'validation',
    successMessage,
    failureMessage
}) {
    const deployResult = cliJson?.result || {};
    const details = deployResult.details || {};
    const componentSuccesses = Array.isArray(details.componentSuccesses)
        ? details.componentSuccesses.length
        : toNumber(deployResult.numberComponentsDeployed);
    const componentFailureList = Array.isArray(details.componentFailures)
        ? details.componentFailures
        : [];
    const componentFailures = componentFailureList.length;
    const failureDetails = mapFailureDetails(componentFailureList);
    const testResults = mapTestResults(details.runTestResult);
    const codeCoverage = calculateOverallCoverage(
        details.runTestResult,
        parseCoverageFromTestResult(cliJson)
    );
    const warnings = mapWarnings(details, cliJson);
    const status = mapDeployStatus(deployResult);
    const success = status === 'SUCCESS';
    const deploymentSummary = buildDeploymentSummary({
        deployResult,
        componentSuccesses,
        componentFailures,
        testResults,
        codeCoverage,
        mode
    });

    let message = success
        ? successMessage ||
          (mode === 'execution'
              ? 'Deployment completed successfully.'
              : 'Check-only deployment validation succeeded.')
        : failureMessage ||
          (mode === 'execution'
              ? 'Deployment failed.'
              : 'Check-only deployment validation failed.');

    if (!success && failureDetails.length) {
        message = failureDetails[0].problem || message;
    } else if (!success && testResults.testsFailed > 0) {
        message =
            testResults.failingTests[0]?.message ||
            (mode === 'execution'
                ? 'Deployment failed due to test failures.'
                : 'Check-only deployment validation failed due to test failures.');
    }

    return applyCliDiagnostics(
        {
            deploymentId: deployResult.id || null,
            status,
            success,
            startTime: deployResult.createdDate || null,
            endTime: deployResult.completedDate || null,
            duration: formatDuration(
                deployResult.createdDate,
                deployResult.completedDate,
                elapsedMs
            ),
            componentSuccesses,
            componentFailures,
            failureDetails,
            testResults,
            codeCoverage,
            warnings,
            deploymentSummary,
            message,
            cliCommand: cliCommand || null,
            cliVersion: cliVersion || null,
            executionMode: executionMode || null
        },
        { cliStdout, cliStderr }
    );
}

function buildBlockedResult(
    message,
    {
        cliStdout = '',
        cliStderr = '',
        cliCommand = null,
        cliVersion = null,
        executionMode = null,
        mode = 'validation'
    } = {}
) {
    const deploymentSummary =
        mode === 'execution'
            ? {
                  componentsDeployed: 0,
                  componentsFailed: 0,
                  testsRun: 0,
                  testsFailed: 0,
                  overallCoverage: 0,
                  deploymentStatus: 'Blocked'
              }
            : {
                  componentsValidated: 0,
                  componentsFailed: 0,
                  testsRun: 0,
                  testsFailed: 0,
                  overallCoverage: 0,
                  deploymentStatus: 'Blocked'
              };

    return applyCliDiagnostics(
        {
            deploymentId: null,
            status: 'BLOCKED',
            success: false,
            startTime: null,
            endTime: null,
            duration: null,
            componentSuccesses: 0,
            componentFailures: 0,
            failureDetails: [],
            testResults: { ...EMPTY_TEST_RESULTS },
            codeCoverage: { ...EMPTY_CODE_COVERAGE },
            warnings: [],
            deploymentSummary,
            message,
            cliCommand,
            cliVersion,
            executionMode
        },
        { cliStdout, cliStderr }
    );
}

function buildFailedResult(
    message,
    {
        cliStdout = '',
        cliStderr = '',
        cliCommand = null,
        cliVersion = null,
        executionMode = null,
        mode = 'validation'
    } = {}
) {
    const deploymentSummary =
        mode === 'execution'
            ? {
                  componentsDeployed: 0,
                  componentsFailed: 0,
                  testsRun: 0,
                  testsFailed: 0,
                  overallCoverage: 0,
                  deploymentStatus: 'Failed'
              }
            : {
                  componentsValidated: 0,
                  componentsFailed: 0,
                  testsRun: 0,
                  testsFailed: 0,
                  overallCoverage: 0,
                  deploymentStatus: 'Failed'
              };

    return applyCliDiagnostics(
        {
            deploymentId: null,
            status: 'FAILED',
            success: false,
            startTime: null,
            endTime: null,
            duration: null,
            componentSuccesses: 0,
            componentFailures: 0,
            failureDetails: [],
            testResults: { ...EMPTY_TEST_RESULTS },
            codeCoverage: { ...EMPTY_CODE_COVERAGE },
            warnings: [],
            deploymentSummary,
            message,
            cliCommand,
            cliVersion,
            executionMode
        },
        { cliStdout, cliStderr }
    );
}

function logDeploymentSummary(result) {
    logSection('Deployment Summary');
    console.log('Deployment ID:', result.deploymentId);
    console.log('Status:', result.status);
    console.log('Success:', result.success);
    console.log('Duration:', result.duration);
    console.log('Component Successes:', result.componentSuccesses);
    console.log('Component Failures:', result.componentFailures);
    console.log('Tests Run:', result.testResults.testsRun);
    console.log('Tests Failed:', result.testResults.testsFailed);
    console.log('Overall Coverage:', result.codeCoverage.overallCoverage);
    console.log('Execution Mode:', result.executionMode);
    console.log('Warnings:', result.warnings);
    console.log('Message:', result.message);
}

async function runCheckOnlyDeployment({
    generatedWorkspace,
    generatedManifest,
    refreshToken,
    instanceUrl
}) {
    logSection('Check-Only Deployment Started');

    if (generatedManifest) {
        // Manifest is consumed upstream; package.xml is already written to workspace.
    }

    const workspaceValidation = validateWorkspace(generatedWorkspace);

    if (!workspaceValidation.ready) {
        const result = buildBlockedResult(workspaceValidation.message);
        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');
        return result;
    }

    if (!refreshToken || !instanceUrl) {
        const result = buildBlockedResult(
            'Missing destination org credentials.'
        );
        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');
        return result;
    }

    let compatibility;
    let cliCompatibility;

    try {
        const compatibilityContext = await getCliCompatibility();
        compatibility = compatibilityContext.compatibility;
        cliCompatibility = buildCliCompatibilityDiagnostics(compatibility, {
            cached: compatibilityContext.cached
        });
    } catch (error) {
        const result = withCliCompatibility(
            buildBlockedResult(
                'Unable to determine Salesforce CLI deployment validation capabilities.'
            ),
            cliCompatibility
        );
        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');
        return result;
    }

    if (!compatibility?.deploymentValidationFlag) {
        const result = withCliCompatibility(
            buildBlockedResult(resolveValidationCapabilityMessage(compatibility), {
                cliVersion: compatibility?.cliVersion || null
            }),
            cliCompatibility
        );
        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');
        return result;
    }

    const workspacePath = path.resolve(workspaceValidation.workspacePath);

    const projectBootstrap = await ensureSfdxProject(workspacePath);

    if (!projectBootstrap.success) {
        const result = buildFailedResult(
            projectBootstrap.message ||
                'Unable to create sfdx-project.json for Salesforce DX project.'
        );
        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');
        return result;
    }

    const alias = `destination-checkonly-${Date.now()}`;
    const executionMode = resolveExecutionMode(
        compatibility.deploymentValidationFlag
    );
    let cliStdout = '';
    let cliStderr = '';
    let deployCommand = null;

    try {
        logSection('Authenticating Destination Org');

        const tokenResult = await refreshAccessToken(refreshToken);
        const resolvedInstanceUrl = tokenResult.instanceUrl || instanceUrl;

        await loginSfOrg(
            tokenResult.accessToken,
            resolvedInstanceUrl,
            alias
        );

        logSection('Running Salesforce CLI');

        deployCommand =
            `cd ${shellQuote(workspacePath)} && ` +
            `sf project deploy start ` +
            `--manifest package.xml ` +
            `${compatibility.deploymentValidationFlag} ` +
            `--target-org ${shellQuote(alias)} ` +
            `--wait 30 ` +
            `--json`;

        let cliJson;
        const cliStartedAt = Date.now();

        try {
            const commandResult = await execAsync(deployCommand, {
                maxBuffer: 50 * 1024 * 1024
            });

            cliStdout = commandResult.stdout || '';
            cliStderr = commandResult.stderr || '';
            cliJson = parseCliJson(cliStdout);
        } catch (error) {
            cliStdout = error.stdout || '';
            cliStderr = error.stderr || error.message || '';

            if (cliStdout) {
                cliJson = parseCliJson(cliStdout);
            } else {
                throw error;
            }
        }

        const elapsedMs = Date.now() - cliStartedAt;

        logSection('Collecting Deployment Results');

        const result = withCliCompatibility(
            mapDeployOutcome({
                cliJson,
                cliStdout,
                cliStderr,
                elapsedMs,
                cliCommand: deployCommand,
                cliVersion: compatibility.cliVersion,
                executionMode
            }),
            cliCompatibility
        );

        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');

        return result;
    } catch (error) {
        console.error('CHECK-ONLY DEPLOYMENT ERROR');
        console.error(error.stderr || error.stdout || error.message);

        const result = withCliCompatibility(
            buildFailedResult(resolveErrorMessage(error), {
                cliStdout,
                cliStderr: cliStderr || error.stderr || '',
                cliCommand: deployCommand,
                cliVersion: compatibility.cliVersion,
                executionMode
            }),
            cliCompatibility
        );

        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');

        return result;
    }
}

module.exports = {
    runCheckOnlyDeployment,
    logSection,
    shellQuote,
    parseCliJson,
    resolveErrorMessage,
    refreshAccessToken,
    loginSfOrg,
    validateWorkspace,
    mapDeployOutcome,
    buildBlockedResult,
    buildFailedResult
};
