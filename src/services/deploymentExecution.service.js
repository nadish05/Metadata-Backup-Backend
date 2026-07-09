const util = require('util');
const path = require('path');
const { exec } = require('child_process');

const { getCliCompatibility, buildCliCompatibilityDiagnostics } = require('./salesforceCliCompatibility.service');
const { ensureSfdxProject } = require('./sfdxProject.service');
const {
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
} = require('./checkOnlyDeployment.service');

const execAsync = util.promisify(exec);

function logExecutionSummary(result) {
    logSection('Deployment Summary');
    console.log('Deployment ID:', result.deploymentId);
    console.log('Status:', result.status);
    console.log('Success:', result.success);
    console.log('Duration:', result.duration);
    console.log('Component Successes:', result.componentSuccesses);
    console.log('Component Failures:', result.componentFailures);
    console.log('Message:', result.message);
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

async function runDeploymentExecution({
    generatedWorkspace,
    generatedManifest,
    deploymentReadiness,
    refreshToken,
    instanceUrl
}) {
    logSection('Deployment Execution Started');

    if (generatedManifest) {
        // Manifest is consumed upstream; package.xml is already written to workspace.
    }

    if (!deploymentReadiness?.canDeploy) {
        const result = buildBlockedResult('Deployment readiness failed.', {
            mode: 'execution',
            executionMode: 'deploy'
        });
        logExecutionSummary(result);
        logSection('Deployment Failed');
        return result;
    }

    const workspaceValidation = validateWorkspace(generatedWorkspace);

    if (!workspaceValidation.ready) {
        const result = buildBlockedResult(
            'Deployment workspace is not ready.',
            {
                mode: 'execution',
                executionMode: 'deploy'
            }
        );
        logExecutionSummary(result);
        logSection('Deployment Failed');
        return result;
    }

    if (!refreshToken || !instanceUrl) {
        const result = buildBlockedResult(
            'Missing destination org credentials.',
            {
                mode: 'execution',
                executionMode: 'deploy'
            }
        );
        logExecutionSummary(result);
        logSection('Deployment Failed');
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
                'Unable to determine Salesforce CLI deployment validation capabilities.',
                {
                    mode: 'execution',
                    executionMode: 'deploy'
                }
            ),
            cliCompatibility
        );
        logExecutionSummary(result);
        logSection('Deployment Failed');
        return result;
    }

    const workspacePath = path.resolve(workspaceValidation.workspacePath);
    const projectBootstrap = await ensureSfdxProject(workspacePath);

    if (!projectBootstrap.success) {
        const result = buildFailedResult(
            projectBootstrap.message ||
                'Unable to create sfdx-project.json for Salesforce DX project.',
            {
                mode: 'execution',
                executionMode: 'deploy',
                cliVersion: compatibility?.cliVersion || null
            }
        );
        logExecutionSummary(result);
        logSection('Deployment Failed');
        return result;
    }

    const alias = `destination-deploy-${Date.now()}`;
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

        logSection('Executing Deployment');

        deployCommand =
            `cd ${shellQuote(workspacePath)} && ` +
            `sf project deploy start ` +
            `--manifest package.xml ` +
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

        logSection('Parsing Deployment Result');

        const result = withCliCompatibility(
            mapDeployOutcome({
                cliJson,
                cliStdout,
                cliStderr,
                elapsedMs,
                cliCommand: deployCommand,
                cliVersion: compatibility.cliVersion,
                executionMode: 'deploy',
                mode: 'execution',
                successMessage: 'Deployment completed successfully.',
                failureMessage: 'Deployment failed.'
            }),
            cliCompatibility
        );

        logExecutionSummary(result);
        logSection(result.success ? 'Deployment Completed' : 'Deployment Failed');

        return result;
    } catch (error) {
        console.error('DEPLOYMENT EXECUTION ERROR');
        console.error(error.stderr || error.stdout || error.message);

        const result = withCliCompatibility(
            buildFailedResult(resolveErrorMessage(error), {
                cliStdout,
                cliStderr: cliStderr || error.stderr || '',
                cliCommand: deployCommand,
                cliVersion: compatibility?.cliVersion || null,
                executionMode: 'deploy',
                mode: 'execution'
            }),
            cliCompatibility
        );

        logExecutionSummary(result);
        logSection('Deployment Failed');

        return result;
    }
}

module.exports = {
    runDeploymentExecution
};
