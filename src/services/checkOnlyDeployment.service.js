const axios = require('axios');
const util = require('util');
const path = require('path');
const { exec } = require('child_process');

const { parseCoverageFromTestResult } = require('./sourceValidation/coverageParser.service');
const {
    getCliCompatibility
} = require('./salesforceCliCompatibility.service');

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

function formatDuration(startTime, endTime, totalTimeMs) {
    if (totalTimeMs != null && totalTimeMs !== '') {
        const seconds = Math.round(toNumber(totalTimeMs) / 1000);

        return seconds > 0 ? `${seconds}s` : `${toNumber(totalTimeMs)}ms`;
    }

    if (startTime && endTime) {
        const milliseconds = new Date(endTime) - new Date(startTime);

        if (Number.isFinite(milliseconds) && milliseconds >= 0) {
            return `${Math.round(milliseconds / 1000)}s`;
        }
    }

    return null;
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
    cliStderr
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

    let message = success
        ? 'Check-only deployment validation succeeded.'
        : 'Check-only deployment validation failed.';

    if (!success && failureDetails.length) {
        message = failureDetails[0].problem || message;
    } else if (!success && testResults.testsFailed > 0) {
        message =
            testResults.failingTests[0]?.message ||
            'Check-only deployment validation failed due to test failures.';
    }

    return {
        deploymentId: deployResult.id || null,
        status,
        success,
        startTime: deployResult.createdDate || null,
        endTime: deployResult.completedDate || null,
        duration: formatDuration(
            deployResult.createdDate,
            deployResult.completedDate,
            details.runTestResult?.totalTime
        ),
        componentSuccesses,
        componentFailures,
        failureDetails,
        testResults,
        codeCoverage,
        warnings,
        message,
        cliStdout,
        cliStderr
    };
}

function buildBlockedResult(message, cliStdout = '', cliStderr = '') {
    return {
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
        message,
        cliStdout,
        cliStderr
    };
}

function buildFailedResult(message, cliStdout = '', cliStderr = '') {
    return {
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
        message,
        cliStdout,
        cliStderr
    };
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

    try {
        compatibility = await getCliCompatibility();
    } catch (error) {
        const result = buildBlockedResult(
            'Installed Salesforce CLI does not support deployment validation.'
        );
        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');
        return result;
    }

    if (!compatibility?.deploymentValidationFlag) {
        const result = buildBlockedResult(
            'Installed Salesforce CLI does not support deployment validation.'
        );
        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');
        return result;
    }

    const workspacePath = path.resolve(workspaceValidation.workspacePath);
    const alias = `destination-checkonly-${Date.now()}`;
    let cliStdout = '';
    let cliStderr = '';

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

        const deployCommand =
            `cd ${shellQuote(workspacePath)} && ` +
            `sf project deploy start ` +
            `--manifest package.xml ` +
            `${compatibility.deploymentValidationFlag} ` +
            `--target-org ${shellQuote(alias)} ` +
            `--wait 30 ` +
            `--json`;

        let cliJson;

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

        logSection('Collecting Deployment Results');

        const result = mapDeployOutcome({
            cliJson,
            cliStdout,
            cliStderr
        });

        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');

        return result;
    } catch (error) {
        console.error('CHECK-ONLY DEPLOYMENT ERROR');
        console.error(error.stderr || error.stdout || error.message);

        const result = buildFailedResult(
            resolveErrorMessage(error),
            cliStdout,
            cliStderr || error.stderr || ''
        );

        logDeploymentSummary(result);
        logSection('Check-Only Deployment Complete');

        return result;
    }
}

module.exports = {
    runCheckOnlyDeployment
};
