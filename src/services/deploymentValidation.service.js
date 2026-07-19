const axios = require('axios');

const metadataValidationService = require('./metadataValidation.service');
const dependencyValidationService = require('./dependencyValidation.service');
const deploymentReadinessService = require('./deploymentReadiness.service');
const deploymentPackageService = require('./deploymentPackage.service');
const packageXmlService = require('./packageXml.service');
const deploymentWorkspaceService = require('./deploymentWorkspace.service');
const checkOnlyDeploymentService = require('./checkOnlyDeployment.service');
const deploymentExecutionService = require('./deploymentExecution.service');
const deploymentHistoryService = require('./deploymentHistory.service');

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function runHistorySafely(operation) {
    try {
        return operation();
    } catch (error) {
        console.error('DEPLOYMENT HISTORY ERROR');
        console.error(error);
        return null;
    }
}

function resolveDeploymentMode(deploymentPackage) {
    const mode = deploymentPackage?.deploymentMode;

    if (mode === 'VALIDATE' || mode === 'DEPLOY') {
        return mode;
    }

    if (deploymentPackage?.executeDeployment === true) {
        return 'DEPLOY';
    }

    return 'VALIDATE';
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

    return error.message || 'Unable to authenticate with destination org.';
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

async function verifyDestinationApiAccess(accessToken, instanceUrl) {
    const response = await axios.get(
        `${instanceUrl}/services/data/`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return response.status >= 200 && response.status < 300;
}

async function validateDestinationConnectivity({
    refreshToken,
    instanceUrl,
    orgId
}) {
    logSection('Deployment Validation Started');

    if (!refreshToken || !instanceUrl) {
        console.log('Destination authentication failed.');

        return {
            success: false,
            deploymentValidation: {
                destinationConnected: false,
                status: 'BLOCKED',
                message: 'Missing destination org credentials.'
            }
        };
    }

    console.log('Generating destination access token...');

    try {
        const tokenResult = await refreshAccessToken(refreshToken);
        const resolvedInstanceUrl =
            tokenResult.instanceUrl || instanceUrl;

        console.log('Destination authentication successful.');

        const apiReachable = await verifyDestinationApiAccess(
            tokenResult.accessToken,
            resolvedInstanceUrl
        );

        if (!apiReachable) {
            console.log('Destination authentication failed.');

            return {
                success: false,
                deploymentValidation: {
                    destinationConnected: false,
                    status: 'BLOCKED',
                    message: 'Unable to authenticate with destination org.'
                }
            };
        }

        logSection('Deployment Validation Complete.');

        return {
            success: true,
            deploymentValidation: {
                destinationConnected: true,
                status: 'PASS',
                message: 'Successfully authenticated with destination org.'
            }
        };
    } catch (error) {
        console.log('Destination authentication failed.');
        console.error(error.response?.data || error.message);

        return {
            success: false,
            deploymentValidation: {
                destinationConnected: false,
                status: 'BLOCKED',
                message: resolveErrorMessage(error)
            }
        };
    }
}

async function validateDeployment({
    refreshToken,
    instanceUrl,
    orgId,
    deploymentPackage
}) {
    const connectivityResult = await validateDestinationConnectivity({
        refreshToken,
        instanceUrl,
        orgId
    });

    if (!deploymentPackage) {
        return connectivityResult;
    }

    const metadataValidation =
        await metadataValidationService.validateMetadataPackage(
            deploymentPackage
        );

    const generatedDeploymentPackage =
        deploymentPackageService.generateDeploymentPackage(deploymentPackage);

    const deploymentPackageForDependencyValidation = {
        ...deploymentPackage,
        selectedMetadata: generatedDeploymentPackage.metadata
    };

    let dependencyValidation;

    if (connectivityResult.deploymentValidation?.destinationConnected) {
        try {
            const tokenResult = await refreshAccessToken(refreshToken);
            const resolvedInstanceUrl =
                tokenResult.instanceUrl || instanceUrl;

            dependencyValidation =
                await dependencyValidationService.validateDependencies({
                    accessToken: tokenResult.accessToken,
                    instanceUrl: resolvedInstanceUrl,
                    deploymentPackage: deploymentPackageForDependencyValidation
                });
        } catch (error) {
            console.error('DEPENDENCY VALIDATION ERROR');
            console.error(error);

            dependencyValidation = {
                overallStatus: 'BLOCKED',
                results: [],
                message:
                    error.message ||
                    'Unable to validate dependencies in destination org.'
            };
        }
    } else {
        dependencyValidation = {
            overallStatus: 'BLOCKED',
            results: [],
            message:
                'Destination org not connected. Dependency validation skipped.'
        };
    }

    const deploymentReadiness =
        deploymentReadinessService.evaluateDeploymentReadiness({
            deploymentValidation: connectivityResult.deploymentValidation,
            metadataValidation,
            dependencyValidation
        });

    const historyId = runHistorySafely(() =>
        deploymentHistoryService.createHistory({
            deploymentPackage,
            deploymentReadiness,
            metadataValidation,
            dependencyValidation
        })
    );

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.PACKAGE_GENERATED,
            metadataSummary: generatedDeploymentPackage.summary
        })
    );

    const generatedManifest = packageXmlService.generateManifest(
        generatedDeploymentPackage
    );

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.MANIFEST_GENERATED,
            manifestSummary: generatedManifest.summary
        })
    );

    const generatedWorkspace =
        await deploymentWorkspaceService.buildDeploymentWorkspace({
            generatedDeploymentPackage,
            generatedManifest,
            repoUrl: deploymentPackage.repoUrl,
            sourceBranch:
                deploymentPackage.sourceBranch || deploymentPackage.branch
        });

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.WORKSPACE_BUILT,
            workspaceSummary: {
                workspaceCreated: generatedWorkspace.workspaceCreated === true,
                workspacePath: generatedWorkspace.workspacePath || null,
                status: generatedWorkspace.status || null,
                metadataCopied: generatedWorkspace.metadataCopied ?? 0,
                dependenciesCopied: generatedWorkspace.dependenciesCopied ?? 0,
                copiedFiles: generatedWorkspace.copiedFiles ?? 0,
                workspaceSize: generatedWorkspace.workspaceSize || null,
                missingFiles: generatedWorkspace.missingFiles || []
            },
            workspacePath: generatedWorkspace.workspacePath || null
        })
    );

    const deploymentMode = resolveDeploymentMode(deploymentPackage);

    logSection('Deployment Mode Selected');
    console.log('Mode:', deploymentMode);

    let checkOnlyDeployment;
    let deploymentExecution;

    if (deploymentMode === 'DEPLOY') {
        deploymentExecution =
            await deploymentExecutionService.runDeploymentExecution({
                generatedWorkspace,
                generatedManifest,
                deploymentReadiness,
                refreshToken,
                instanceUrl
            });
    } else {
        checkOnlyDeployment =
            await checkOnlyDeploymentService.runCheckOnlyDeployment({
                generatedWorkspace,
                generatedManifest,
                refreshToken,
                instanceUrl
            });
    }

    const response = {
        ...connectivityResult,
        metadataValidation,
        dependencyValidation,
        deploymentReadiness,
        generatedDeploymentPackage,
        generatedManifest,
        generatedWorkspace
    };

    if (deploymentMode === 'DEPLOY') {
        response.deploymentExecution = deploymentExecution;
    } else {
        response.checkOnlyDeployment = checkOnlyDeployment;
    }

    const deploymentResult =
        deploymentMode === 'DEPLOY'
            ? deploymentExecution
            : checkOnlyDeployment;

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage:
                deploymentMode === 'DEPLOY'
                    ? deploymentHistoryService.STAGES.DEPLOYMENT_EXECUTED
                    : deploymentHistoryService.STAGES.CHECK_ONLY_COMPLETED,
            deploymentSummary: deploymentResult?.deploymentSummary || null,
            deploymentId: deploymentResult?.deploymentId || null,
            errors: deploymentResult?.success === false && deploymentResult?.message
                ? [deploymentResult.message]
                : []
        })
    );

    const deploymentHistory = runHistorySafely(() =>
        deploymentHistoryService.completeHistory(historyId, {
            deploymentMode,
            deploymentReadiness,
            generatedWorkspace,
            deploymentResult,
            destinationOrgId: orgId ?? null,
            sourceOrgId: deploymentPackage?.sourceOrgId ?? null,
            deploymentPlanId: deploymentPackage?.deploymentPlanId ?? null,
            metadataComparisonId:
                deploymentPackage?.metadataComparisonId ?? null
        })
    );

    if (deploymentHistory) {
        response.deploymentHistory = deploymentHistory;
    }

    return response;
}

module.exports = {
    validateDestinationConnectivity,
    validateDeployment
};
