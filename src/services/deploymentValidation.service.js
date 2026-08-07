const axios = require('axios');

const metadataValidationService = require('./metadataValidation.service');
const dependencyValidationService = require('./dependencyValidation.service');
const deploymentReadinessService = require('./deploymentReadiness.service');
const deploymentReadinessAnalysisService = require('./deploymentReadinessAnalysis.service');
const formulaCompatibilityService = require('./formulaCompatibility.service');
const deploymentCompatibilityPlanService = require('./deploymentCompatibility.service');
const deploymentCompatibilityFilterService = require('./deploymentCompatibilityFilter.service');
const deploymentCompatibilityImpactService = require('./deploymentCompatibilityImpact.service');
const deploymentCompatibilityGateService = require('./deploymentCompatibilityGate.service');
const deploymentCompatibilityAdvisorService = require('./deploymentCompatibilityAdvisor.service');
const deploymentPreviewService = require('./deploymentPreview.service');
const deploymentPermissionSetCompatibilityService = require('./deploymentPermissionSetCompatibility.service');
const deploymentApiNegotiationService = require('./deploymentApiNegotiation.service');
const metadataApiAdoptionTrace = require('./metadataApiAdoptionTrace.temp');
const personAccountTrace = require('./personAccountTrace.temp');
const personAccountQueryTrace = require('./personAccountQueryTrace.temp');
const repositorySnapshotMetadataService = require('./repositorySnapshotMetadata.service');
const deploymentPackageService = require('./deploymentPackage.service');
const deploymentPackageProvenanceService = require('./deploymentPackageProvenance.service');
const packageXmlService = require('./packageXml.service');
const deploymentWorkspaceService = require('./deploymentWorkspace.service');
const checkOnlyDeploymentService = require('./checkOnlyDeployment.service');
const deploymentExecutionService = require('./deploymentExecution.service');
const deploymentHistoryService = require('./deploymentHistory.service');
const metadataCompatibilityService = require('./metadataCompatibility/metadataCompatibility.service');
const dependencyResolutionService = require('./dependencyResolution/dependencyResolution.service');
const relationshipDiscoveryService = require('./dependencyResolution/relationshipDiscovery.service');
const referenceDiscoveryService = require('./dependencyResolution/referenceDiscovery.service');
const graphExpansionService = require('./dependencyResolution/graphExpansion/graphExpansion.service');
const artifactResolutionService = require('./repositoryArtifacts/artifactResolution.service');
const dependencyExplorerService = require('./dependencyResolution/dependencyExplorer.service');
const deploymentCompatibilityAnalyzerService = require('./deploymentCompatibility/deploymentCompatibilityAnalyzer.service');
const {
    extractDeploymentSelections
} = require('./deploymentPlanner/deploymentSelections.foundation');
const deploymentPlannerService = require('./deploymentPlanner/deploymentPlanner.service');
const deploymentPlannerCompatibilityAnalyzerService = require('./deploymentPlannerCompatibility/deploymentPlannerCompatibility.analyzer.service');
const {
    attachCustomObjectGraphTrustShadow,
    attachCustomFieldContractTrustShadow
} = require('./deploymentPlanner/plannerAuthorization.service');
const {
    buildDestinationInventory,
    toDestinationStateMap,
    getLatestApiVersion
} = require('./destinationInventory/destinationInventoryBuilder.service');
const {
    resolveDeploymentApiVersionPolicyAsync
} = require('./deploymentApiVersionPolicy.service');
const { DEFAULT_API_VERSION } = require('../config/salesforce');
const {
    buildDestinationShapeIndex,
    serializeDestinationShapeIndex
} = require('./destinationShape/destinationShapeBuilder.service');
const {
    buildSourceCustomFieldShapeIndexFromRepo
} = require('./deploymentPlannerCompatibility/contract/sourceCustomFieldShapeBuilder.service');
const {
    normalizeDeployableMetadata
} = require('./deployableMetadataNormalizer.service');
const {
    classifyDeploymentFailures
} = require('./deploymentFailureClassification/deploymentFailureClassification.service');
const {
    buildResolutionReport
} = require('./deploymentFailureClassification/deploymentResolution.service');
const {
    applyAutoFixes
} = require('./deploymentFailureClassification/deploymentAutoFix.service');

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

/**
 * Collapse physical LWC file rows into logical deployable components
 * before any Validation-stage consumer reads selectedMetadata.
 * Does not mutate the callers original package object.
 */
function prepareDeploymentPackageForValidation(deploymentPackage) {
    if (!deploymentPackage || typeof deploymentPackage !== 'object') {
        return deploymentPackage;
    }

    const normalizedSelectedMetadata = normalizeDeployableMetadata(
        deploymentPackage.selectedMetadata
    );

    return {
        ...deploymentPackage,
        selectedMetadata: normalizedSelectedMetadata
    };
}

/**
 * Collect metadata participating in validation for Destination Inventory.
 * Does not mutate inventories or affect Deploy/Skip decisions by itself.
 */
function collectDestinationInventoryItems({
    selectedMetadata,
    requiredDependencies,
    discoveredReferences
} = {}) {
    const byKey = new Map();

    const addItem = (metadataType, metadataName) => {
        if (!metadataType || !metadataName) {
            return;
        }

        const key = `${metadataType}:${metadataName}`;

        if (!byKey.has(key)) {
            byKey.set(key, { metadataType, metadataName });
        }
    };

    for (const item of selectedMetadata || []) {
        addItem(
            item?.metadataType || item?.type,
            item?.metadataName || item?.name
        );
    }

    for (const item of requiredDependencies || []) {
        addItem(
            item?.metadataType || item?.type,
            item?.metadataName || item?.name
        );
    }

    for (const item of discoveredReferences || []) {
        addItem(
            item?.metadataType || item?.type,
            item?.metadataName || item?.name
        );
    }

    return [...byKey.values()];
}

/**
 * Prepare analyzer-only copies enriched from Destination Inventory.
 * Does not mutate planner / resolution inventories.
 * Missing inventory entries → UNKNOWN (never invent EXISTS/MISSING).
 */
function enrichAnalyzerItemsWithDestinationState(items, destinationStates) {
    if (!Array.isArray(items)) {
        return [];
    }

    const states =
        destinationStates instanceof Map ? destinationStates : new Map();

    return items.map((item) => {
        const metadataType = item?.metadataType || item?.type || null;
        const metadataName = item?.metadataName || item?.name || null;

        let destinationState = 'UNKNOWN';

        if (metadataType && metadataName) {
            const key = `${metadataType}:${metadataName}`;

            if (states.has(key)) {
                const inventoryState = states.get(key);

                if (
                    inventoryState === 'EXISTS' ||
                    inventoryState === 'MISSING' ||
                    inventoryState === 'UNKNOWN'
                ) {
                    destinationState = inventoryState;
                }
            }
        }

        return {
            ...item,
            destinationState
        };
    });
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

    // TEMPORARY DEBUG ONLY — remove after Postman testing.
    if (tokenResponse.data?.access_token && tokenResponse.data?.instance_url) {
        console.log('======================================================');
        console.log('DESTINATION SALESFORCE ACCESS TOKEN');
        console.log('======================================================');
        console.log('Access Token:');
        console.log(tokenResponse.data.access_token);
        console.log('Instance URL:');
        console.log(tokenResponse.data.instance_url);
        console.log('======================================================');
    }

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

    // Normalize physical LWC files → logical components once, before every
    // Validation consumer (metadata validation, discovery, package, etc.).
    deploymentPackage =
        prepareDeploymentPackageForValidation(deploymentPackage);

    // Deployment Planner selections (preferences). Applied after Dependency
    // Resolution and before Compatibility; Package Generation is unchanged.
    const reservedDeploymentSelections =
        extractDeploymentSelections(deploymentPackage);

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
    // Phase 6B: retain expansion edges for Planner Compatibility (report-only).
    let discoveredEdges = [];
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
    // Destination Inventory state map retained for analyzer enrichment (Step 5).
    let destinationStatesForAnalyzer = new Map();
    // Phase 9B — CustomField structural facts for future CONTRACT (unused by planner).
    let destinationShapeIndex = null;
    // Phase 9C — source CustomField structural facts for CONTRACT evaluation.
    let sourceShapeIndex = null;

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

    // TEMP (Phase 15.3.1) — reset the PersonAccount trace for this request.
    personAccountTrace.beginPersonAccountTrace();
    // TEMP (Phase 15.3.2) — reset the PersonAccount destination query trace.
    personAccountQueryTrace.beginQueryTrace();

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
        const expansionResult = await graphExpansionService.expandMetadataGraph(
            {
                selectedMetadata: deploymentPackage.selectedMetadata,
                discoveredRelationships,
                discoveredReferences,
                enrichedDependencies: enrichedRequiredDependencies,
                repoUrl: deploymentPackage.repoUrl,
                sourceBranch:
                    deploymentPackage.sourceBranch || deploymentPackage.branch
            }
        );

        const expansionReferences =
            expansionResult.discoveredReferences || [];
        const expansionDependencies =
            expansionResult.discoveredDependencies || [];
        discoveredEdges = Array.isArray(expansionResult.discoveredEdges)
            ? expansionResult.discoveredEdges
            : [];

        if (expansionReferences.length) {
            const referenceKeys = new Set(
                discoveredReferences.map(
                    (item) =>
                        item.id ||
                        `${item.metadataType || item.type}:${item.name}`
                )
            );

            for (const reference of expansionReferences) {
                const key =
                    reference.id ||
                    `${reference.metadataType || reference.type}:${reference.name}`;

                if (referenceKeys.has(key)) {
                    continue;
                }

                referenceKeys.add(key);
                discoveredReferences.push(reference);
            }

            referenceSummary = {
                ...referenceSummary,
                referencesDiscovered: discoveredReferences.length,
                blockingReferences: discoveredReferences.filter(
                    (item) => item.blocking
                ).length,
                deployableReferences: discoveredReferences.filter(
                    (item) => item.deployable
                ).length,
                warnings: [
                    ...(referenceSummary.warnings || []),
                    ...(expansionResult.warnings || [])
                ]
            };
        }

        if (expansionDependencies.length) {
            const dependencyKeys = new Set(
                (enrichedRequiredDependencies || []).map(
                    (item) =>
                        `${item.type || item.metadataType}:${item.name}`
                )
            );

            for (const dependency of expansionDependencies) {
                const key = `${dependency.type || dependency.metadataType}:${dependency.name}`;

                if (dependencyKeys.has(key)) {
                    continue;
                }

                dependencyKeys.add(key);

                enrichedRequiredDependencies.push(dependency);
            }
        }

        if (expansionResult.summary) {
            graphExpansionSummary = {
                ...graphExpansionSummary,
                ...expansionResult.summary,
                warnings: [
                    ...(graphExpansionSummary.warnings || []),
                    ...(expansionResult.summary.warnings || [])
                ]
            };
        }
    } catch (error) {
        console.error('METADATA GRAPH EXPANSION ERROR');
        console.error(error);

        discoveredEdges = [];
        graphExpansionSummary = {
            ...graphExpansionSummary,
            warnings: [
                ...(graphExpansionSummary.warnings || []),
                error.message ||
                    'Metadata graph expansion failed; continuing with existing discoveries.'
            ]
        };
    }

    let artifactEnrichedSelectedMetadata =
        deploymentPackage.selectedMetadata || [];
    let artifactResolutionSummary = {
        nodesResolved: 0,
        artifactsFound: 0,
        artifactsMissing: 0,
        warnings: []
    };

    try {
        const artifactResult =
            await artifactResolutionService.resolveRepositoryArtifacts({
                selectedMetadata: deploymentPackage.selectedMetadata,
                discoveredRelationships,
                discoveredReferences,
                enrichedDependencies: enrichedRequiredDependencies,
                repoUrl: deploymentPackage.repoUrl,
                sourceBranch:
                    deploymentPackage.sourceBranch || deploymentPackage.branch
            });

        artifactEnrichedSelectedMetadata =
            artifactResult.selectedMetadata ||
            artifactEnrichedSelectedMetadata;
        discoveredRelationships =
            artifactResult.discoveredRelationships || discoveredRelationships;
        discoveredReferences =
            artifactResult.discoveredReferences || discoveredReferences;
        enrichedRequiredDependencies =
            artifactResult.enrichedDependencies ||
            enrichedRequiredDependencies;
        artifactResolutionSummary =
            artifactResult.summary || artifactResolutionSummary;
    } catch (error) {
        console.error('REPOSITORY ARTIFACT RESOLUTION ERROR');
        console.error(error);

        artifactResolutionSummary = {
            nodesResolved: 0,
            artifactsFound: 0,
            artifactsMissing: 0,
            warnings: [
                error.message ||
                    'Repository artifact resolution failed; continuing without artifact paths.'
            ]
        };
    }

    try {
        // Phase 3D — Destination Inventory feeds Dependency Resolution.
        // Inventory Map → toDestinationStateMap → context.destinationStates.
        let destinationStates = new Map();
        let destinationStateWarnings = [];
        let inventoryItems = [];

        try {
            inventoryItems = collectDestinationInventoryItems({
                selectedMetadata: artifactEnrichedSelectedMetadata,
                requiredDependencies: enrichedRequiredDependencies,
                discoveredReferences
            });

            const inventoryResult = await buildDestinationInventory({
                items: inventoryItems,
                accessToken: accessTokenForDownstream,
                instanceUrl: resolvedInstanceUrl
            });

            destinationStates = toDestinationStateMap(
                inventoryResult.inventory
            );
            destinationStateWarnings = Array.isArray(
                inventoryResult.summary?.warnings
            )
                ? inventoryResult.summary.warnings
                : [];
        } catch (inventoryError) {
            console.error('DESTINATION INVENTORY BUILDER ERROR');
            console.error(inventoryError);
            destinationStates = new Map();
            destinationStateWarnings = [
                inventoryError.message ||
                    'Destination inventory failed; continuing with UNKNOWN destination states.'
            ];
        }

        // Phase 9B — Destination Shape (CustomField structural facts only).
        // Does not feed planner / authorization / CONTRACT evaluation yet.
        try {
            destinationShapeIndex = await buildDestinationShapeIndex({
                items: inventoryItems,
                accessToken: accessTokenForDownstream,
                instanceUrl: resolvedInstanceUrl
            });
        } catch (shapeError) {
            console.error('DESTINATION SHAPE BUILDER ERROR');
            console.error(shapeError);
            destinationShapeIndex = {
                shapes: new Map(),
                summary: {
                    requested: 0,
                    resolved: 0,
                    missing: 0,
                    unknown: 0,
                    unsupported: 0,
                    objectsDescribed: 0,
                    warnings: [
                        shapeError.message ||
                            'Destination shape build failed; continuing without shape facts.'
                    ]
                }
            };
        }

        // Phase 9C — source CustomField shapes (repo XML). No destination describe.
        try {
            sourceShapeIndex = await buildSourceCustomFieldShapeIndexFromRepo({
                items: inventoryItems,
                repoUrl: deploymentPackage.repoUrl,
                sourceBranch:
                    deploymentPackage.sourceBranch || deploymentPackage.branch
            });
        } catch (sourceShapeError) {
            console.error('SOURCE CUSTOM FIELD SHAPE BUILDER ERROR');
            console.error(sourceShapeError);
            sourceShapeIndex = new Map();
        }

        // Retain for Planner Compatibility Analyzer enrichment (Step 5).
        // Does not mutate planner inputs; analyzer receives enriched copies only.
        destinationStatesForAnalyzer = destinationStates;

        const resolutionResult =
            await dependencyResolutionService.resolveDependencies({
                requiredDependencies: enrichedRequiredDependencies,
                discoveredReferences,
                selectedMetadata: artifactEnrichedSelectedMetadata,
                accessToken: accessTokenForDownstream,
                instanceUrl: resolvedInstanceUrl,
                destinationStates,
                destinationStateWarnings
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

    // Phase 1 — Planner Compatibility Analyzer (report-only).
    // Phase 3D Step 5 — enrich analyzer inputs from Destination Inventory.
    // Phase 6F — EXISTENCE for planner first; graphSafe synced after effective package.
    let plannerCompatibilityReport = null;
    let graphTruncatedForCompatibility = false;

    try {
        const analyzerSelectedMetadata =
            enrichAnalyzerItemsWithDestinationState(
                artifactEnrichedSelectedMetadata,
                destinationStatesForAnalyzer
            );
        const analyzerResolvedDependencies =
            enrichAnalyzerItemsWithDestinationState(
                resolvedRequiredDependencies,
                destinationStatesForAnalyzer
            );

        graphTruncatedForCompatibility = [
            ...(graphExpansionSummary.warnings || []),
            ...(relationshipDiscoverySummary.warnings || [])
        ].some((warning) =>
            /maximum depth|truncated|incomplete/i.test(String(warning || ''))
        );

        plannerCompatibilityReport =
            deploymentPlannerCompatibilityAnalyzerService.analyzePlannerCompatibility(
                {
                    selectedMetadata: analyzerSelectedMetadata,
                    resolvedDependencies: analyzerResolvedDependencies,
                    // Graph evaluation deferred until post-planner package (Phase 6F).
                    includeGraphEvaluation: false,
                    graphTruncated: graphTruncatedForCompatibility,
                    // Phase 9C — CONTRACT facts (CustomField); not trusted yet.
                    destinationShapeIndex,
                    sourceShapeIndex
                }
            );
    } catch (error) {
        console.error('PLANNER COMPATIBILITY ANALYZER ERROR');
        console.error(error);
        plannerCompatibilityReport = null;
    }

    // Apply Deployment Planner overrides AFTER Dependency Resolution and
    // BEFORE Compatibility so Compatibility validates the committed plan.
    // Applies to both selectedMetadata and requiredDependencies decisions.
    try {
        const plannerResult = deploymentPlannerService.applyPlannerOverrides({
            selectedMetadata: artifactEnrichedSelectedMetadata,
            resolvedDependencies: resolvedRequiredDependencies,
            deploymentSelections: reservedDeploymentSelections,
            // Phase 2A: wired into planner; intentionally unused for decisions.
            plannerCompatibilityReport
        });

        artifactEnrichedSelectedMetadata =
            plannerResult.selectedMetadata ||
            artifactEnrichedSelectedMetadata;
        resolvedRequiredDependencies =
            plannerResult.resolvedDependencies ||
            resolvedRequiredDependencies;
    } catch (error) {
        console.error('DEPLOYMENT PLANNER ERROR');
        console.error(error);
        // Keep resolved decisions unchanged if planner application fails.
    }

    try {
        deploymentCompatibility =
            deploymentCompatibilityAnalyzerService.analyzeDeploymentCompatibility(
                {
                    selectedMetadata: artifactEnrichedSelectedMetadata,
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
                selectedMetadata: artifactEnrichedSelectedMetadata,
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
        selectedMetadata: artifactEnrichedSelectedMetadata,
        requiredDependencies: resolvedRequiredDependencies
    };

    let generatedDeploymentPackage =
        deploymentPackageService.generateDeploymentPackage(
            deploymentPackageWithResolvedDependencies
        );

    // TEMP (Phase 15.3.1) — PersonAccount trace step 5.
    personAccountTrace.logPackageStep({
        generatedDeploymentPackage,
        resolvedDependencies: resolvedRequiredDependencies
    });

    // Report-only: explain WHY members exist in the generated package.
    // Must not influence package, validation, planner, manifest, workspace, or deploy.
    const deploymentPackageProvenance =
        deploymentPackageProvenanceService.buildDeploymentPackageProvenance({
            generatedDeploymentPackage,
            selectedMetadata: artifactEnrichedSelectedMetadata,
            discoveredRelationships,
            discoveredReferences,
            resolvedDependencies: resolvedRequiredDependencies
        });

    // Phase 6F — synchronize graphSafe to the effective generated package.
    // Does not re-run planner; preserves analysisLevel / canSkip from pre-planner report.
    try {
        if (plannerCompatibilityReport) {
            const analyzerSelectedMetadata =
                enrichAnalyzerItemsWithDestinationState(
                    artifactEnrichedSelectedMetadata,
                    destinationStatesForAnalyzer
                );
            const analyzerResolvedDependencies =
                enrichAnalyzerItemsWithDestinationState(
                    resolvedRequiredDependencies,
                    destinationStatesForAnalyzer
                );

            plannerCompatibilityReport =
                deploymentPlannerCompatibilityAnalyzerService.synchronizePlannerCompatibilityGraph(
                    plannerCompatibilityReport,
                    {
                        selectedMetadata: analyzerSelectedMetadata,
                        resolvedDependencies: analyzerResolvedDependencies,
                        discoveredRelationships,
                        discoveredReferences,
                        discoveredEdges,
                        graphTruncated: graphTruncatedForCompatibility,
                        generatedDeploymentPackage,
                        destinationShapeIndex,
                        sourceShapeIndex
                    }
                );

            // Phase 8B — CustomObject GRAPH trust shadow (report-only).
            // Does not change TRUST_POLICY, planner decisions, or package.
            plannerCompatibilityReport = attachCustomObjectGraphTrustShadow(
                plannerCompatibilityReport
            );

            // Phase 9D — CustomField CONTRACT trust shadow (report-only).
            plannerCompatibilityReport = attachCustomFieldContractTrustShadow(
                plannerCompatibilityReport
            );
        }
    } catch (error) {
        console.error('PLANNER COMPATIBILITY GRAPH SYNC ERROR');
        console.error(error);
    }

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
                // Reporting only: validate the same inventory the deploy package uses.
                // Phase 3D Step 6 — existsInDestination from Destination Inventory (no re-query).
                dependencyValidation =
                    await dependencyValidationService.validateDependencies({
                        accessToken: accessTokenForDownstream,
                        instanceUrl: resolvedInstanceUrl,
                        deploymentPackage:
                            deploymentPackageWithResolvedDependencies,
                        generatedDeploymentPackage,
                        destinationStates: destinationStatesForAnalyzer
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

    // Deployment API Version Policy — before manifest generation only.
    let deploymentApiVersionPolicy = null;
    let packageSourceReadFile = null;
    let repositorySnapshotMetadata = null;
    deploymentPackage.sourceApiVersion = null;

    try {
        let destinationMaxApiVersion = null;

        if (accessTokenForDownstream && resolvedInstanceUrl) {
            try {
                destinationMaxApiVersion = await getLatestApiVersion(
                    resolvedInstanceUrl,
                    accessTokenForDownstream
                );
            } catch (versionError) {
                console.error('DESTINATION MAX API VERSION ERROR');
                console.error(versionError);
            }
        }

        try {
            packageSourceReadFile =
                await deploymentWorkspaceService.createRepositoryFileReader(
                    deploymentPackage.repoUrl,
                    deploymentPackage.sourceBranch || deploymentPackage.branch
                );
        } catch (readerError) {
            console.error('API VERSION POLICY FILE READER ERROR');
            console.error(readerError);
        }

        repositorySnapshotMetadata =
            await repositorySnapshotMetadataService.readRepositorySnapshotMetadata(
                {
                    readFile: packageSourceReadFile
                }
            );
        deploymentPackage.sourceApiVersion =
            repositorySnapshotMetadata?.sourceMetadataApiVersion || null;

        deploymentApiVersionPolicy =
            await resolveDeploymentApiVersionPolicyAsync({
                selectedMetadata: [
                    ...(deploymentPackage.selectedMetadata || []),
                    ...(generatedDeploymentPackage.metadata || []),
                    ...(generatedDeploymentPackage.dependencies || [])
                ],
                workspaceMetadata: generatedDeploymentPackage.metadata || [],
                destinationMaxApiVersion,
                readFile: packageSourceReadFile
            });

        // Expose to planner compatibility report without redesigning trust.
        if (plannerCompatibilityReport?.plannerCompatibility) {
            plannerCompatibilityReport.plannerCompatibility.deploymentApiVersionPolicy =
                deploymentApiVersionPolicy;
        }
    } catch (policyError) {
        console.error('DEPLOYMENT API VERSION POLICY ERROR');
        console.error(policyError);
        deploymentApiVersionPolicy = {
            deploymentApiVersion: DEFAULT_API_VERSION,
            policy: 'HIGHEST_REQUIRED',
            compatible: true,
            reason: null,
            warnings: [
                policyError.message ||
                    'API version policy failed; falling back to DEFAULT_API_VERSION.'
            ]
        };
    }

    // TEMP (Phase 13.7) — remove after repository snapshot verification.
    console.log('====================================================');
    console.log('REPOSITORY SNAPSHOT METADATA');
    console.log('====================================================');
    console.log('');
    console.log(
        'Snapshot Found:',
        repositorySnapshotMetadata ? 'YES' : 'NO'
    );
    console.log('');
    console.log(
        'Source Org:',
        repositorySnapshotMetadata?.sourceOrgId || '(unknown)'
    );
    console.log('');
    console.log(
        'Source Metadata API:',
        repositorySnapshotMetadata?.sourceMetadataApiVersion || '(unknown)'
    );
    console.log('');
    console.log(
        'Loaded Into Deployment Package:',
        deploymentPackage?.sourceApiVersion ? 'YES' : 'NO'
    );
    console.log('');
    console.log('====================================================');

    // Phase 13.3/13.4 — negotiate and safely adopt the deployment API.
    const deploymentApiNegotiation =
        deploymentApiNegotiationService.negotiateDeploymentApiVersionsSafe({
            sourceApiVersion: deploymentPackage?.sourceApiVersion || null,
            destinationApiVersion:
                deploymentApiVersionPolicy?.destinationMaxApiVersion || null,
            currentDeploymentApiVersion:
                deploymentApiVersionPolicy?.deploymentApiVersion ||
                DEFAULT_API_VERSION,
            deploymentPackage,
            embeddedApiVersions:
                deploymentApiVersionPolicy?.embeddedApiVersions || []
        });

    // TEMP (Phase 13.7) — remove after negotiation input verification.
    console.log('====================================================');
    console.log('NEGOTIATION INPUT');
    console.log('====================================================');
    console.log('');
    console.log(
        'Source API:',
        deploymentApiNegotiation?.sourceApiVersion || '(unknown)'
    );
    console.log('');
    console.log(
        'Destination API:',
        deploymentApiNegotiation?.destinationApiVersion || '(unknown)'
    );
    console.log('');
    console.log(
        'Negotiated API:',
        deploymentApiNegotiation?.negotiatedApiVersion || '(unknown)'
    );
    console.log('');
    console.log('====================================================');

    const deploymentApiVersion =
        deploymentApiNegotiationService.resolveDeploymentApiVersion({
            deploymentApiNegotiation,
            currentDeploymentApiVersion:
                deploymentApiVersionPolicy?.deploymentApiVersion ||
                DEFAULT_API_VERSION
        }) || DEFAULT_API_VERSION;
    deploymentApiNegotiation.deploymentApiVersion = deploymentApiVersion;

    // Compatibility logic is unchanged; only its API-version source advances
    // to the effective mutually supported version.
    const compatibilityApiVersionPolicy = {
        ...deploymentApiVersionPolicy,
        deploymentApiVersion:
            deploymentApiNegotiation?.effectiveCompatibilityApiVersion ||
            deploymentApiVersion
    };

    // TEMP (Phase 13.5) — adoption trace stage 1.
    metadataApiAdoptionTrace.beginAdoptionTrace();
    metadataApiAdoptionTrace.logNegotiationStage({
        currentDeploymentApiVersion:
            deploymentApiNegotiation?.currentDeploymentApiVersion,
        sourceApiVersion: deploymentApiNegotiation?.sourceApiVersion,
        destinationApiVersion: deploymentApiNegotiation?.destinationApiVersion,
        negotiatedApiVersion: deploymentApiNegotiation?.negotiatedApiVersion,
        effectiveCompatibilityApiVersion:
            deploymentApiNegotiation?.effectiveCompatibilityApiVersion,
        negotiationStatus: deploymentApiNegotiation?.negotiationStatus,
        adoptedDeploymentApiVersion: deploymentApiVersion
    });

    const deploymentReadiness =
        deploymentReadinessService.evaluateDeploymentReadiness({
            deploymentValidation: connectivityResult.deploymentValidation,
            metadataValidation,
            dependencyValidation,
            deploymentApiVersionPolicy
        });

    // Phase 10.9 — static pre-deploy risk report only.
    // Never mutates package, never changes canDeploy / execution gates.
    let deploymentReadinessAnalysis =
        deploymentReadinessAnalysisService.buildEmptyAnalysis(
            'Readiness analysis not evaluated.'
        );

    try {
        deploymentReadinessAnalysis =
            await deploymentReadinessAnalysisService.analyzeDeploymentReadiness({
                generatedDeploymentPackage,
                discoveredReferences,
                deploymentApiVersionPolicy,
                readFile: packageSourceReadFile,
                repoFiles: [
                    ...(generatedDeploymentPackage?.metadata || []),
                    ...(generatedDeploymentPackage?.dependencies || [])
                ]
                    .map((item) => item?.filePath)
                    .filter(Boolean)
            });
    } catch (analysisError) {
        console.error('DEPLOYMENT READINESS ANALYSIS ERROR');
        console.error(analysisError);
        deploymentReadinessAnalysis =
            deploymentReadinessAnalysisService.buildEmptyAnalysis(
                analysisError.message ||
                    'Deployment readiness analysis failed.'
            );
        deploymentReadinessAnalysis.overallStatus = 'WARNING';
        deploymentReadinessAnalysis.recommendations = [
            'Static deployment readiness analysis could not complete; review deploy diagnostics if failures occur.'
        ];
    }

    // Additive nest only — gate fields (overallStatus/canDeploy) unchanged.
    deploymentReadiness.staticAnalysis = deploymentReadinessAnalysis;
    deploymentReadiness.rollupSummaryValidation =
        deploymentReadinessAnalysis.rollupSummaryValidation || {
            overallStatus: 'PASS',
            validatedCount: 0,
            blockingCount: 0,
            issues: []
        };

    // Phase 10.23 — Formula Compatibility Validator (warnings only).
    // Does not fail validation or change package / planner / deploy gates.
    let formulaCompatibility = {
        overallStatus: 'PASS',
        warnings: [],
        summary: {
            analyzed: 0,
            warningCount: 0,
            reason: null
        }
    };

    try {
        const existingFindings = [
            ...(Array.isArray(compatibilityFindings)
                ? compatibilityFindings
                : []),
            ...(Array.isArray(metadataValidation?.findings)
                ? metadataValidation.findings
                : []),
            ...(Array.isArray(metadataValidation?.warnings)
                ? metadataValidation.warnings
                : []),
            ...(Array.isArray(deploymentReadinessAnalysis?.findings)
                ? deploymentReadinessAnalysis.findings
                : [])
        ];

        formulaCompatibility =
            await formulaCompatibilityService.analyzeFormulaCompatibility({
                generatedDeploymentPackage,
                readFile: packageSourceReadFile,
                existingFindings
            });
    } catch (formulaCompatibilityError) {
        console.error('FORMULA COMPATIBILITY VALIDATION ERROR');
        console.error(formulaCompatibilityError);
        formulaCompatibility = {
            overallStatus: 'WARNING',
            warnings: [
                {
                    metadataName: null,
                    metadataType: 'CustomField',
                    severity: 'WARNING',
                    category: 'FORMULA_CONVERSION',
                    message:
                        formulaCompatibilityError.message ||
                        'Formula compatibility validation failed.'
                }
            ],
            summary: {
                analyzed: 0,
                warningCount: 1,
                reason:
                    formulaCompatibilityError.message ||
                    'Formula compatibility validation failed.'
            }
        };
    }

    // Phase 13.1/13.2 — PermissionSet compatibility diagnostics feed the
    // existing compatibility planner. Analysis is fail-safe and read-only.
    const permissionSetCompatibility =
        await deploymentPermissionSetCompatibilityService.analyzePermissionSetCompatibilitySafe(
            {
                generatedDeploymentPackage,
                deploymentApiVersionPolicy: compatibilityApiVersionPolicy,
                readFile: packageSourceReadFile
            }
        );

    // Phase 10.24 — Deployment Compatibility Planner (warnings only).
    // Distinct from dependency validation. Does not change deploy behavior.
    let deploymentCompatibilityPlan = {
        overallStatus: 'PASS',
        compatibilityWarnings: [],
        summary: {
            warningCount: 0,
            reason: null
        }
    };

    try {
        const compatibilityPlanFindings = [
            ...(Array.isArray(compatibilityFindings)
                ? compatibilityFindings
                : []),
            ...(Array.isArray(metadataValidation?.findings)
                ? metadataValidation.findings
                : []),
            ...(Array.isArray(metadataValidation?.warnings)
                ? metadataValidation.warnings
                : []),
            ...(Array.isArray(deploymentReadinessAnalysis?.findings)
                ? deploymentReadinessAnalysis.findings
                : []),
            ...(Array.isArray(formulaCompatibility?.warnings)
                ? formulaCompatibility.warnings
                : [])
        ];

        // TEMP (Phase 13.5) — adoption trace stage 2.
        metadataApiAdoptionTrace.logPlannerInputStage({
            plannerApiVersion:
                compatibilityApiVersionPolicy?.deploymentApiVersion,
            effectiveCompatibilityApiVersion:
                deploymentApiNegotiation?.effectiveCompatibilityApiVersion,
            negotiatedApiVersion:
                deploymentApiNegotiation?.negotiatedApiVersion
        });

        deploymentCompatibilityPlan =
            await deploymentCompatibilityPlanService.analyzeDeploymentCompatibilityPlan(
                {
                    generatedDeploymentPackage,
                    formulaCompatibility,
                    permissionSetCompatibility,
                    existingFindings: compatibilityPlanFindings,
                    deploymentApiVersionPolicy:
                        compatibilityApiVersionPolicy,
                    readFile: packageSourceReadFile
                }
            );
    } catch (compatibilityPlanError) {
        console.error('DEPLOYMENT COMPATIBILITY PLAN ERROR');
        console.error(compatibilityPlanError);
        deploymentCompatibilityPlan = {
            overallStatus: 'WARNING',
            compatibilityWarnings: [
                {
                    metadataName: null,
                    metadataType: null,
                    category: 'FORMULA_COMPILATION',
                    severity: 'WARNING',
                    message:
                        compatibilityPlanError.message ||
                        'Deployment compatibility planning failed.',
                    recommendation:
                        'Review destination compatibility manually before deploy.'
                }
            ],
            summary: {
                warningCount: 1,
                reason:
                    compatibilityPlanError.message ||
                    'Deployment compatibility planning failed.'
            }
        };
    }

    // Phase 11.1 — Compatibility Package Filter (AUTO EXCLUDE).
    // Removes only incompatible package members; does not block deployment.
    let compatibilityPackageFilter = {
        excludedComponents: [],
        compatibilitySummary: {
            totalExcluded: 0,
            totalRemaining: 0,
            excludedByCategory: {}
        }
    };

    try {
        const filterResult = deploymentCompatibilityFilterService.filter({
            generatedDeploymentPackage,
            deploymentCompatibilityPlan
        });

        generatedDeploymentPackage = filterResult.deploymentPackage;
        compatibilityPackageFilter = {
            excludedComponents: filterResult.excludedComponents || [],
            compatibilitySummary: filterResult.compatibilitySummary || {
                totalExcluded: 0,
                totalRemaining: 0,
                excludedByCategory: {}
            }
        };
    } catch (compatibilityFilterError) {
        console.error('COMPATIBILITY PACKAGE FILTER ERROR');
        console.error(compatibilityFilterError);
        // Fail-open: keep unfiltered package so deployment behavior is unchanged.
        compatibilityPackageFilter = {
            excludedComponents: [],
            compatibilitySummary: {
                totalExcluded: 0,
                totalRemaining:
                    (generatedDeploymentPackage?.metadata || []).length +
                    (generatedDeploymentPackage?.dependencies || []).length,
                excludedByCategory: {}
            }
        };
    }

    // Phase 11.2 — Compatibility Dependency Impact Analysis (report-only).
    // Does not modify package, workspace, manifest, or CLI.
    let deploymentCompatibilityImpact = {
        blockingComponents: [],
        blockingSummary: {
            totalBlocking: 0,
            blockingByMetadataType: {},
            blockingByCategory: {}
        }
    };

    try {
        deploymentCompatibilityImpact =
            deploymentCompatibilityImpactService.analyze({
                filteredDeploymentPackage: generatedDeploymentPackage,
                excludedComponents:
                    compatibilityPackageFilter?.excludedComponents || [],
                resolvedDependencies: resolvedRequiredDependencies,
                discoveredRelationships,
                discoveredReferences,
                dependencyExplorer
            });
    } catch (compatibilityImpactError) {
        console.error('COMPATIBILITY IMPACT ANALYSIS ERROR');
        console.error(compatibilityImpactError);
        deploymentCompatibilityImpact = {
            blockingComponents: [],
            blockingSummary: {
                totalBlocking: 0,
                blockingByMetadataType: {},
                blockingByCategory: {}
            }
        };
    }

    const compatibilityBlockingComponents =
        deploymentCompatibilityPlanService.mergeCompatibilityBlockingComponents(
            deploymentCompatibilityImpact?.blockingComponents || [],
            deploymentCompatibilityPlan?.blockingComponents || []
        );
    const compatibilityBlockingSummary =
        deploymentCompatibilityPlanService.buildBlockingSummary(
            compatibilityBlockingComponents
        );

    // Phase 11.3 — Compatibility Deployment Readiness Planner (report-only).
    // Does not cancel deployment or mutate package / workspace / CLI.
    const compatibilityDeploymentReadiness =
        deploymentReadinessService.planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: generatedDeploymentPackage,
            excludedComponents:
                compatibilityPackageFilter?.excludedComponents || [],
            blockingComponents: compatibilityBlockingComponents,
            compatibilitySummary:
                compatibilityPackageFilter?.compatibilitySummary || null,
            blockingSummary: compatibilityBlockingSummary,
            totalWarnings: Array.isArray(
                deploymentCompatibilityPlan?.compatibilityWarnings
            )
                ? deploymentCompatibilityPlan.compatibilityWarnings.length
                : 0
        });

    deploymentReadiness.readyForDeployment =
        compatibilityDeploymentReadiness.readyForDeployment;
    deploymentReadiness.deployableComponents =
        compatibilityDeploymentReadiness.deployableComponents;
    deploymentReadiness.excludedComponents =
        compatibilityDeploymentReadiness.excludedComponents;
    deploymentReadiness.blockingComponents =
        compatibilityDeploymentReadiness.blockingComponents;
    deploymentReadiness.compatibilitySummary =
        compatibilityDeploymentReadiness.summary;
    deploymentReadiness.reason = compatibilityDeploymentReadiness.reason;

    // Phase 11.6 — Enterprise Compatibility Advisor (read-only guidance).
    // Does not change package, readiness, gate, workspace, or CLI behavior.
    const deploymentCompatibilityAdvisor =
        deploymentCompatibilityAdvisorService.buildDeploymentCompatibilityAdvisorSafe(
            {
                deploymentCompatibilityPlan,
                deploymentCompatibilityImpact,
                deploymentReadiness,
                excludedComponents:
                    compatibilityPackageFilter?.excludedComponents || [],
                blockingComponents: compatibilityBlockingComponents,
                compatibilityWarnings:
                    deploymentCompatibilityPlan?.compatibilityWarnings || [],
                deploymentApiNegotiation
            }
        );

    // Phase 12.1 — Enterprise Deployment Preview (read-only).
    // Describes post-compatibility deployable set. Does not change behavior.
    const deploymentPreview = deploymentPreviewService.buildDeploymentPreviewSafe(
        {
            generatedDeploymentPackage,
            deploymentReadiness,
            deploymentCompatibilityAdvisor,
            excludedComponents:
                compatibilityPackageFilter?.excludedComponents || [],
            blockingComponents: compatibilityBlockingComponents,
            compatibilityWarnings:
                deploymentCompatibilityPlan?.compatibilityWarnings || [],
            deploymentApiNegotiation: {
                ...deploymentApiNegotiation,
                currentDeploymentApiVersion: deploymentApiVersion
            }
        }
    );

    const historyId = runHistorySafely(() =>
        deploymentHistoryService.createHistory({
            deploymentPackage,
            deploymentReadiness,
            metadataValidation,
            dependencyValidation,
            // Planner selections retained for history storage only.
            deploymentSelections: reservedDeploymentSelections
        })
    );

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.PACKAGE_GENERATED,
            metadataSummary: generatedDeploymentPackage.summary
        })
    );

    // TEMP (Phase 13.5) — adoption trace stage 4.
    metadataApiAdoptionTrace.logPackageStage({
        packageApiVersion: deploymentApiVersion
    });

    const generatedManifest = packageXmlService.generateManifest(
        generatedDeploymentPackage,
        {
            deploymentApiVersion,
            deploymentApiVersionPolicy: {
                ...deploymentApiVersionPolicy,
                deploymentApiVersion
            }
        }
    );

    // Diagnostics only — logs the manifest that will be deployed.
    console.log('====================================================');
    console.log('GENERATED PACKAGE.XML');
    console.log('====================================================');
    console.log(generatedManifest?.packageXml || '(empty package.xml)');
    console.log('====================================================');

    // TEMP (Phase 13.5) — adoption trace stage 5.
    metadataApiAdoptionTrace.logManifestStage({
        packageXml: generatedManifest?.packageXml,
        manifestSummary: generatedManifest?.summary
    });

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage: deploymentHistoryService.STAGES.MANIFEST_GENERATED,
            manifestSummary: generatedManifest.summary
        })
    );

    const artifactCompatibilityBlocked = (compatibilityFindings || []).some(
        (finding) =>
            finding.ruleId === 'artifact.exists' &&
            (finding.status === 'FAIL' ||
                finding.status === 'BLOCK' ||
                finding.blocking === true)
    );

    // Phase 11.4 — Deployment gate using compatibility readiness.
    // Skips workspace + CLI when readyForDeployment === false.
    const compatibilityDeploymentSkipped =
        deploymentCompatibilityGateService.shouldSkipDeploymentForCompatibility(
            deploymentReadiness
        );

    let generatedWorkspace;

    // TEMP (Phase 15.3.1) — PersonAccount trace step 6.
    personAccountTrace.logWorkspaceStep({
        resolvedDependencies: resolvedRequiredDependencies,
        generatedDeploymentPackage,
        workspaceSkipped:
            compatibilityDeploymentSkipped || artifactCompatibilityBlocked,
        skipReason: compatibilityDeploymentSkipped
            ? 'Compatibility readiness reported blocking dependencies.'
            : artifactCompatibilityBlocked
              ? 'Missing source artifacts blocked workspace construction.'
              : null
    });

    if (compatibilityDeploymentSkipped) {
        generatedWorkspace =
            deploymentCompatibilityGateService.buildCompatibilitySkippedWorkspace();
    } else if (artifactCompatibilityBlocked) {
        const missingArtifacts = (compatibilityFindings || [])
            .filter(
                (finding) =>
                    finding.ruleId === 'artifact.exists' &&
                    (finding.status === 'FAIL' ||
                        finding.status === 'BLOCK' ||
                        finding.blocking === true)
            )
            .map((finding) => finding.metadataName)
            .filter(Boolean);

        generatedWorkspace = {
            workspacePath: null,
            workspaceCreated: false,
            packageXmlWritten: false,
            metadataCopied: 0,
            dependenciesCopied: 0,
            copiedFiles: 0,
            workspaceSize: '0 B',
            missingFiles: missingArtifacts,
            status: 'BLOCKED',
            skippedReason:
                'Workspace skipped because one or more source artifacts are missing from the selected source branch.'
        };

        console.log(
            'Workspace Builder skipped due to missing source artifacts:',
            missingArtifacts
        );
    } else {
        // TEMP (Phase 13.5) — adoption trace stage 6.
        metadataApiAdoptionTrace.logWorkspaceStage({
            deploymentApiVersion:
                generatedManifest?.summary?.apiVersion || deploymentApiVersion
        });

        generatedWorkspace =
            await deploymentWorkspaceService.buildDeploymentWorkspace({
                generatedDeploymentPackage,
                generatedManifest,
                repoUrl: deploymentPackage.repoUrl,
                sourceBranch:
                    deploymentPackage.sourceBranch || deploymentPackage.branch
            });
    }

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

    if (
        !compatibilityDeploymentSkipped &&
        generatedWorkspace.status === 'READY'
    ) {
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
                compatibilityDeploymentSkipped
                    ? 'Workspace skipped due to compatibility blocking dependencies.'
                    : 'Workspace not READY; compatibility processing skipped'
            ]
        };
    }

    const deploymentMode = resolveDeploymentMode(deploymentPackage);

    logSection('Deployment Mode Selected');
    console.log('Mode:', deploymentMode);

    let checkOnlyDeployment;
    let deploymentExecution;

    // TEMP (Phase 15.3.1) — PersonAccount trace step 7 and final report.
    personAccountTrace.logDeploymentStep({
        resolvedDependencies: resolvedRequiredDependencies,
        generatedDeploymentPackage,
        dependencyResolutionSummary,
        dependencyValidationStatus: dependencyValidation?.overallStatus || null,
        deploymentSkipped: compatibilityDeploymentSkipped,
        deploymentMode
    });
    personAccountTrace.logPersonAccountReport();

    if (!compatibilityDeploymentSkipped) {
        if (deploymentMode === 'DEPLOY') {
            deploymentExecution =
                await deploymentExecutionService.runDeploymentExecution({
                    generatedWorkspace,
                    generatedManifest,
                    deploymentReadiness,
                    refreshToken,
                    instanceUrl,
                    deploymentApiVersion
                });
        } else {
            checkOnlyDeployment =
                await checkOnlyDeploymentService.runCheckOnlyDeployment({
                    generatedWorkspace,
                    generatedManifest,
                    refreshToken,
                    instanceUrl,
                    deploymentApiVersion
                });
        }
    }

    // TEMP (Phase 13.5) — adoption reconciliation report.
    metadataApiAdoptionTrace.logAdoptionReport();

    const response = {
        ...connectivityResult,
        metadataValidation,
        dependencyValidation,
        deploymentReadiness,
        // Phase 10.9 — report-only static analysis (PASS/WARNING/FAIL).
        // Distinct from deploymentReadiness gate (READY/BLOCKED + canDeploy).
        deploymentReadinessAnalysis,
        formulaCompatibility,
        deploymentCompatibilityPlan,
        compatibilityWarnings:
            deploymentCompatibilityPlan?.compatibilityWarnings || [],
        compatibilityPackageFilter,
        excludedComponents:
            compatibilityPackageFilter?.excludedComponents || [],
        deploymentCompatibilityImpact,
        blockingComponents: compatibilityBlockingComponents,
        blockingSummary: compatibilityBlockingSummary,
        deploymentCompatibilityAdvisor,
        deploymentPreview,
        permissionSetCompatibility,
        deploymentApiNegotiation,
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
        dependencyResolutionSummary,
        deploymentApiVersionPolicy,
        // Phase 9B — facts only; not consumed by planner / authorization / package.
        destinationShape: destinationShapeIndex
            ? serializeDestinationShapeIndex(destinationShapeIndex)
            : null,
        // Additive report-only provenance. Output only — never consumed by backend.
        deploymentPackageProvenance
    };

    if (compatibilityDeploymentSkipped) {
        Object.assign(
            response,
            deploymentCompatibilityGateService.buildCompatibilitySkipFields({
                deploymentReadiness,
                compatibilitySummary:
                    compatibilityPackageFilter?.compatibilitySummary || null,
                excludedComponents:
                    compatibilityPackageFilter?.excludedComponents || [],
                blockingComponents: compatibilityBlockingComponents
            })
        );
    } else if (deploymentMode === 'DEPLOY') {
        response.deploymentExecution = deploymentExecution;
    } else {
        response.checkOnlyDeployment = checkOnlyDeployment;
    }

    const deploymentResult =
        compatibilityDeploymentSkipped
            ? null
            : deploymentMode === 'DEPLOY'
              ? deploymentExecution
              : checkOnlyDeployment;

    // Additive diagnostics only — existing nested deploy payloads unchanged.
    if (deploymentResult?.deploymentDiagnostics) {
        response.deploymentDiagnostics = deploymentResult.deploymentDiagnostics;
    }

    // Phase 17.2 — read-only failure classification + resolution recommendations.
    // Additive only: never mutates package, workspace, CLI results, or gates.
    const failureClassification = classifyDeploymentFailures({
        deploymentDiagnostics: response.deploymentDiagnostics || null,
        deployOutcome: deploymentResult,
        dependencyValidation,
        deploymentCompatibilityPlan,
        compatibilityWarnings:
            deploymentCompatibilityPlan?.compatibilityWarnings || [],
        selectedMetadata: Array.isArray(deploymentPackage?.selectedMetadata)
            ? deploymentPackage.selectedMetadata
            : Array.isArray(deploymentPackage?.metadata)
              ? deploymentPackage.metadata
              : []
    });
    const resolutionReport = buildResolutionReport({
        failureClassification,
        deploymentDiagnostics: response.deploymentDiagnostics || null,
        dependencyResolutionSummary,
        dependencyValidation,
        deploymentCompatibility,
        deploymentPackage: generatedDeploymentPackage,
        selectedMetadata: Array.isArray(deploymentPackage?.selectedMetadata)
            ? deploymentPackage.selectedMetadata
            : Array.isArray(deploymentPackage?.metadata)
              ? deploymentPackage.metadata
              : []
    });

    response.failureClassification = failureClassification;
    response.resolutionReport = resolutionReport;

    // Phase 17.3 — Auto Fix Orchestrator (additive).
    // Reuses existing package/workspace services only. Never retries CLI,
    // never mutates source metadata, never edits package.xml directly.
    const autoFixResult = await applyAutoFixes({
        failureClassification,
        resolutionReport,
        dependencyResolutionSummary,
        resolvedDependencies: resolvedRequiredDependencies,
        deploymentPackage,
        generatedDeploymentPackage,
        generatedWorkspace,
        generatedManifest,
        selectedMetadata: Array.isArray(deploymentPackage?.selectedMetadata)
            ? deploymentPackage.selectedMetadata
            : Array.isArray(deploymentPackage?.metadata)
              ? deploymentPackage.metadata
              : [],
        repoUrl: deploymentPackage?.repoUrl || null,
        sourceBranch:
            deploymentPackage?.sourceBranch || deploymentPackage?.branch || null,
        deploymentApiVersion,
        deploymentApiVersionPolicy
    });

    response.autoFixReport = {
        autoFixAvailable: autoFixResult.autoFixAvailable === true,
        autoFixApplied: autoFixResult.autoFixApplied === true,
        fixes: Array.isArray(autoFixResult.fixes) ? autoFixResult.fixes : []
    };

    if (autoFixResult.autoFixApplied === true) {
        if (autoFixResult.generatedDeploymentPackage) {
            response.generatedDeploymentPackage =
                autoFixResult.generatedDeploymentPackage;
        }
        if (autoFixResult.generatedManifest) {
            response.generatedManifest = autoFixResult.generatedManifest;
        }
        if (autoFixResult.generatedWorkspace) {
            response.generatedWorkspace = autoFixResult.generatedWorkspace;
        }
    }

    runHistorySafely(() =>
        deploymentHistoryService.updateHistory(historyId, {
            stage:
                compatibilityDeploymentSkipped
                    ? deploymentHistoryService.STAGES.PACKAGE_GENERATED
                    : deploymentMode === 'DEPLOY'
                      ? deploymentHistoryService.STAGES.DEPLOYMENT_EXECUTED
                      : deploymentHistoryService.STAGES.CHECK_ONLY_COMPLETED,
            deploymentSummary: deploymentResult?.deploymentSummary || null,
            deploymentId: deploymentResult?.deploymentId || null,
            errors: compatibilityDeploymentSkipped
                ? ['BLOCKING_DEPENDENCIES']
                : deploymentResult?.success === false &&
                    deploymentResult?.message
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
    validateDeployment,
    prepareDeploymentPackageForValidation
};
