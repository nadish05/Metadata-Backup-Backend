const util = require('util');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const { getCliCompatibility, buildCliCompatibilityDiagnostics } = require('./salesforceCliCompatibility.service');
const { ensureSfdxProject } = require('./sfdxProject.service');
const metadataApiAdoptionTrace = require('./metadataApiAdoptionTrace.temp');
const {
    logSection,
    shellQuote,
    buildProjectDeployCommand,
    parseCliJson,
    resolveErrorMessage,
    refreshAccessToken,
    loginSfOrg,
    validateWorkspace,
    mapDeployOutcome,
    buildBlockedResult,
    buildFailedResult
} = require('./checkOnlyDeployment.service');
const {
    isCheckOnlySuccess,
    buildActualDeploymentBlockedMessage
} = require('./deploymentCheckOnlyGate.service');

const execAsync = util.promisify(exec);
const rm = util.promisify(fs.rm);
const access = util.promisify(fs.access);

function logExecutionSummary(result) {
    logSection('Deployment Summary');
    console.log('Deployment ID:', result.deploymentId);
    console.log('Overall Status:', result.status);
    console.log('Success:', result.success);
    console.log('Duration:', result.duration);
    console.log('Total Successes:', result.componentSuccesses);
    console.log('Total Failures:', result.componentFailures);
    console.log('Message:', result.message);

    const failures = result.deploymentDiagnostics?.componentFailures || [];

    if (failures.length) {
        console.log('Component Failure Details:');

        for (const failure of failures) {
            console.log(failure.metadataType || 'Unknown');
            console.log(
                failure.metadataName || failure.fullName || failure.fileName || 'n/a'
            );
            console.log(failure.problem || 'Unknown problem');
            console.log('------------------------------------');
        }
    }
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

async function pathExists(targetPath) {
    try {
        await access(targetPath, fs.constants.F_OK);
        return true;
    } catch (error) {
        return false;
    }
}

async function deleteDeploymentWorkspace(workspacePath) {
    if (!workspacePath) {
        return;
    }

    try {
        if (await pathExists(workspacePath)) {
            await rm(workspacePath, { recursive: true, force: true });
            console.log('Deleted deployment workspace:', workspacePath);
        }
    } catch (error) {
        console.error('DEPLOYMENT CLEANUP ERROR (workspace)');
        console.error(error.message || error);
    }
}

async function logoutDeploymentAlias(alias) {
    if (!alias) {
        return;
    }

    try {
        await execAsync(
            `sf org logout --target-org ${shellQuote(alias)} --noprompt`
        );
        console.log('Logged out Salesforce CLI alias:', alias);
    } catch (error) {
        console.error('DEPLOYMENT CLEANUP ERROR (logout)');
        console.error(error.stderr || error.stdout || error.message || error);
    }
}

async function deleteTemporaryAuthFiles(workspacePath) {
    if (!workspacePath) {
        return;
    }

    const candidates = [
        path.join(workspacePath, '.sf'),
        path.join(workspacePath, '.sfdx')
    ];

    for (const candidate of candidates) {
        try {
            if (await pathExists(candidate)) {
                await rm(candidate, { recursive: true, force: true });
                console.log('Deleted temporary auth path:', candidate);
            }
        } catch (error) {
            console.error('DEPLOYMENT CLEANUP ERROR (auth files)');
            console.error(error.message || error);
        }
    }
}

async function cleanupDeploymentResources({ alias, workspacePath } = {}) {
    logSection('Deployment Cleanup Started');

    await deleteDeploymentWorkspace(workspacePath);
    await logoutDeploymentAlias(alias);
    await deleteTemporaryAuthFiles(workspacePath);

    logSection('Deployment Cleanup Complete');
}

async function runDeploymentExecution({
    generatedWorkspace,
    generatedManifest,
    deploymentReadiness,
    priorCheckOnlyDeployment,
    refreshToken,
    instanceUrl,
    deploymentApiVersion
}) {
    logSection('Deployment Execution Started');

    let alias = null;
    let workspacePath = generatedWorkspace?.workspacePath
        ? path.resolve(generatedWorkspace.workspacePath)
        : null;

    try {
        if (generatedManifest) {
            // Manifest is consumed upstream; package.xml is already written to workspace.
        }

        // Safety gate: Salesforce check-only must have executed and succeeded.
        // Missing / unknown / not-executed / failed check-only → do not deploy.
        if (!isCheckOnlySuccess(priorCheckOnlyDeployment)) {
            const result = buildBlockedResult(
                buildActualDeploymentBlockedMessage(priorCheckOnlyDeployment),
                {
                    mode: 'execution',
                    executionMode: 'deploy'
                }
            );
            logExecutionSummary(result);
            logSection('Deployment Failed');
            return result;
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

        workspacePath = path.resolve(workspaceValidation.workspacePath);
        const projectBootstrap = await ensureSfdxProject(workspacePath, {
            sourceApiVersion:
                generatedManifest?.summary?.apiVersion ||
                generatedManifest?.deploymentApiVersionPolicy
                    ?.deploymentApiVersion ||
                undefined
        });

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

        alias = `destination-deploy-${Date.now()}`;
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

            const resolvedDeploymentApiVersion =
                deploymentApiVersion ||
                generatedManifest?.summary?.apiVersion ||
                generatedManifest?.deploymentApiVersionPolicy
                    ?.deploymentApiVersion;

            // TEMP (Phase 13.5) — adoption trace stage 7.
            metadataApiAdoptionTrace.logCliStage({
                deploymentApiVersion: resolvedDeploymentApiVersion
            });

            deployCommand = buildProjectDeployCommand({
                workspacePath,
                alias,
                deploymentApiVersion: resolvedDeploymentApiVersion
            });

            // TEMP (Phase 13.5) — adoption trace stage 8.
            metadataApiAdoptionTrace.logCliCommandStage({
                cliCommand: deployCommand
            });

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
    } finally {
        await cleanupDeploymentResources({
            alias,
            workspacePath
        });
    }
}

module.exports = {
    runDeploymentExecution
};
