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
const metadataCompatibilityService = require('./metadataCompatibility/metadataCompatibility.service');
const dependencyResolutionService = require('./dependencyResolution/dependencyResolution.service');
const relationshipDiscoveryService = require('./dependencyResolution/relationshipDiscovery.service');
const referenceDiscoveryService = require('./dependencyResolution/referenceDiscovery.service');
const dependencyExplorerService = require('./dependencyResolution/dependencyExplorer.service');
const deploymentCompatibilityAnalyzerService = require('./deploymentCompatibility/deploymentCompatibilityAnalyzer.service');

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

    let dependencyResolutionSummary = {
        analyzed: 0,
        deploy: 0,
        reference: 0,
        skip: 0,
        block: 0,
        warnings: []
    };
    let relationshipDiscoverySummary = {
        metadataScanned: 0,
        filesScanned: 0,
        relationshipsDiscovered: 0,
        lookupRelationships: 0,
        masterDetailRelationships: 0,
        warnings: []
    };
    let graphExpansionSummary = {
        iterations: 0,
        graphDepth: 0,
        metadataNodes: 0,
        relationships: 0,
        newDependencies: 0,
        warnings: []
    };
    let discoveredRelationships = [];
    let discoveredReferences = [];
    let referenceSummary = {
        referencesDiscovered: 0,
        byType: {},
        blockingReferences: 0,
        deployableReferences: 0,
        warnings: []
    };
    let dependencyExplorer = {
        nodes: [],
        edges: [],
        warnings: []
    };
    let relationshipTree = [];
    let graphStatistics = {
        totalNodes: 0,
        relationships: 0,
        referenceCount: 0,
        graphDepth: 0,
        blockingReferences: 0,
        deployableReferences: 0
    };
    let deploymentCompatibility = {
        overallCompatibility: 'PASS',
        findings: [],
        summary: {
            rulesExecuted: 0,
            findings: 0,
            warnings: 0,
            blockers: 0,
            metadataChecked: 0
        }
    };
    let compatibilitySummary = deploymentCompatibility.summary;
    let compatibilityFindings = [];
    let resolvedRequiredDependencies =
        deploymentPackage.requiredDependencies || [];
    let enrichedRequiredDependencies =
        deploymentPackage.requiredDependencies || [];

    let accessTokenForDownstream = null;
    let resolvedInstanceUrl = instanceUrl;

    if (connectivityResult.deploymentValidation?.destinationConnected) {
        try {
            const tokenResult = await refreshAccessToken(refreshToken);
            accessTokenForDownstream = tokenResult.accessToken;
            resolvedInstanceUrl = tokenResult.instanceUrl || instanceUrl;
        } catch (error) {
            console.error('DEPENDENCY RESOLUTION TOKEN ERROR');
            console.error(error);
        }
    }

    try {
        const discoveryResult =
            await relationshipDiscoveryService.discoverRelationships({
                selectedMetadata: deploymentPackage.selectedMetadata,
                requiredDependencies: deploymentPackage.requiredDependencies,
                repoUrl: deploymentPackage.repoUrl,
                sourceBranch:
                    deploymentPackage.sourceBranch || deploymentPackage.branch
            });

        enrichedRequiredDependencies =
            discoveryResult.enrichedDependencies ||
            enrichedRequiredDependencies;
        relationshipDiscoverySummary =
            discoveryResult.summary || relationshipDiscoverySummary;
        graphExpansionSummary =
            discoveryResult.graphExpansionSummary || graphExpansionSummary;
        discoveredRelationships =
            discoveryResult.discoveredRelationships || [];
    } catch (error) {
        console.error('RELATIONSHIP DISCOVERY ERROR');
        console.error(error);

        relationshipDiscoverySummary = {
            metadataScanned: 0,
            filesScanned: 0,
            relationshipsDiscovered: 0,
            lookupRelationships: 0,
            masterDetailRelationships: 0,
            warnings: [
                error.message ||
                    'Relationship discovery failed; continuing with existing dependencies.'
            ]
        };
        graphExpansionSummary = {
            iterations: 0,
            graphDepth: 0,
            metadataNodes: 0,
            relationships: 0,
            newDependencies: 0,
            warnings: [
                error.message ||
                    'Relationship discovery failed; continuing with existing dependencies.'
            ]
        };
        discoveredRelationships = [];
        enrichedRequiredDependencies =
            deploymentPackage.requiredDependencies || [];
    }

    try {
        const referenceResult =
            await referenceDiscoveryService.discoverReferences({
                selectedMetadata: deploymentPackage.selectedMetadata,
                discoveredRelationships,
                enrichedDependencies: enrichedRequiredDependencies,
                repoUrl: deploymentPackage.repoUrl,
                sourceBranch:
                    deploymentPackage.sourceBranch || deploymentPackage.branch
            });

        discoveredReferences = referenceResult.discoveredReferences || [];
        referenceSummary =
            referenceResult.referenceSummary || referenceSummary;
    } catch (error) {
        console.error('METADATA REFERENCE DISCOVERY ERROR');
        console.error(error);

        discoveredReferences = [];
        referenceSummary = {
            referencesDiscovered: 0,
            byType: {},
            blockingReferences: 0,
            deployableReferences: 0,
            warnings: [
                error.message ||
                    'Reference discovery failed; continuing without references.'
            ]
        };
    }

    try {
        const resolutionResult =
            await dependencyResolutionService.resolveDependencies({
                requiredDependencies: enrichedRequiredDependencies,
                selectedMetadata: deploymentPackage.selectedMetadata,
                accessToken: accessTokenForDownstream,
                instanceUrl: resolvedInstanceUrl
            });

        resolvedRequiredDependencies =
            resolutionResult.resolvedDependencies ||
            resolvedRequiredDependencies;
        dependencyResolutionSummary =
            resolutionResult.summary || dependencyResolutionSummary;
    } catch (error) {
        console.error('DEPENDENCY RESOLUTION ERROR');
        console.error(error);

        dependencyResolutionSummary = {
            analyzed: 0,
            deploy: 0,
            reference: 0,
            skip: 0,
            block: 0,
            warnings: [
                error.message ||
                    'Dependency resolution failed; using original dependencies.'
            ]
        };
        resolvedRequiredDependencies = enrichedRequiredDependencies;
    }

    try {
        deploymentCompatibility =
            deploymentCompatibilityAnalyzerService.analyzeDeploymentCompatibility(
                {
                    selectedMetadata: deploymentPackage.selectedMetadata,
                    discoveredRelationships,
                    discoveredReferences,
                    resolvedDependencies: resolvedRequiredDependencies
                }
            );
        compatibilitySummary =
            deploymentCompatibility.summary || compatibilitySummary;
        compatibilityFindings = deploymentCompatibility.findings || [];
    } catch (error) {
        console.error('DEPLOYMENT COMPATIBILITY ANALYZER ERROR');
        console.error(error);

        deploymentCompatibility = {
            overallCompatibility: 'WARNING',
            findings: [],
            summary: {
                rulesExecuted: 0,
                findings: 0,
                warnings: 1,
                blockers: 0,
                metadataChecked: 0
            }
        };
        compatibilitySummary = deploymentCompatibility.summary;
        compatibilityFindings = [
            {
                id: 'analyzer:ERROR',
                metadataName: null,
                metadataType: null,
                ruleId: 'analyzer',
                severity: 'WARNING',
                status: 'WARNING',
                reason:
                    error.message ||
                    'Deployment compatibility analysis failed.',
                requiredBy: null,
                recommendedAction: 'Review analyzer logs and retry analysis.',
                blocking: false,
                source: 'DeploymentCompatibilityAnalyzer'
            }
        ];
    }

    try {
        const explorerResult =
            dependencyExplorerService.buildDependencyExplorer({
                selectedMetadata: deploymentPackage.selectedMetadata,
                discoveredRelationships,
                discoveredReferences,
                resolvedDependencies: resolvedRequiredDependencies,
                referenceSummary
            });

        dependencyExplorer =
            explorerResult.dependencyExplorer || dependencyExplorer;
        relationshipTree = explorerResult.relationshipTree || [];
        referenceSummary =
            explorerResult.referenceSummary || referenceSummary;
        graphStatistics = explorerResult.graphStatistics || graphStatistics;
    } catch (error) {
        console.error('DEPENDENCY EXPLORER ERROR');
        console.error(error);
        dependencyExplorer = {
            nodes: [],
            edges: [],
            warnings: [
                error.message || 'Dependency explorer failed.'
            ]
        };
    }

    const deploymentPackageWithResolvedDependencies = {
        ...deploymentPackage,
        requiredDependencies: resolvedRequiredDependencies
    };

    const generatedDeploymentPackage =
        deploymentPackageService.generateDeploymentPackage(
            deploymentPackageWithResolvedDependencies
        );

    const deploymentPackageForDependencyValidation = {
        ...deploymentPackageWithResolvedDependencies,
        selectedMetadata: generatedDeploymentPackage.metadata
    };

    let dependencyValidation;

    if (connectivityResult.deploymentValidation?.destinationConnected) {
        if (!accessTokenForDownstream) {
            dependencyValidation = {
                overallStatus: 'BLOCKED',
                results: [],
                message:
                    'Unable to validate dependencies in destination org.'
            };
        } else {
            try {
                dependencyValidation =
                    await dependencyValidationService.validateDependencies({
                        accessToken: accessTokenForDownstream,
                        instanceUrl: resolvedInstanceUrl,
                        deploymentPackage:
                            deploymentPackageForDependencyValidation
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
        }
    } else {
        dependencyValidation = {
            overallStatus: 'BLOCKED',
            results: [],
            message:
                'Destination org not connected. Dependency validation skipped.'
        };
    }

    if (
        dependencyResolutionSummary.block > 0 &&
        dependencyValidation?.overallStatus !== 'BLOCKED'
    ) {
        dependencyValidation = {
            ...dependencyValidation,
            overallStatus: 'BLOCKED',
            message:
                dependencyValidation?.message ||
                'Dependency resolution blocked one or more dependencies.'
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

    let compatibilitySummary;

    if (generatedWorkspace.status === 'READY') {
        compatibilitySummary =
            await metadataCompatibilityService.processWorkspace({
                workspacePath: generatedWorkspace.workspacePath
            });
    } else {
        compatibilitySummary = {
            status: 'SKIPPED',
            rulesExecuted: [],
            filesModified: [],
            warnings: [
                'Workspace not READY; compatibility processing skipped'
            ]
        };
    }

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
        generatedWorkspace,
        compatibilitySummary,
        relationshipDiscoverySummary,
        graphExpansionSummary,
        discoveredRelationships,
        discoveredReferences,
        referenceSummary,
        dependencyExplorer,
        relationshipTree,
        graphStatistics,
        deploymentCompatibility,
        compatibilitySummary,
        compatibilityFindings,
        dependencyResolutionSummary
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
