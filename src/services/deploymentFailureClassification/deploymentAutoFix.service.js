/**
 * Deployment Auto Fix Orchestrator (Phase 17.3).
 *
 * Orchestrates deterministic package/workspace fixes by reusing existing
 * deployment pipeline services. Never mutates source metadata, never edits
 * package.xml or workspace files directly, never retries deployment, and
 * never invents discovery or resolution decisions.
 */

const deploymentPackageService = require('../deploymentPackage.service');
const packageXmlService = require('../packageXml.service');
const deploymentWorkspaceService = require('../deploymentWorkspace.service');

const FIX_TYPES = Object.freeze({
    INCLUDE_DISCOVERED_DEPENDENCY: 'INCLUDE_DISCOVERED_DEPENDENCY',
    REGENERATE_PACKAGE: 'REGENERATE_PACKAGE',
    REBUILD_WORKSPACE: 'REBUILD_WORKSPACE'
});

const SUPPORTED_INCLUDE_TYPES = Object.freeze(
    new Set([
        'ApexClass',
        'Flow',
        'CustomObject',
        'ExternalCredential',
        'CustomTab',
        'CustomPermission',
        'ExternalDataSource',
        'CustomApplication'
    ])
);

const INCLUDE_RESOLUTION_TYPES = Object.freeze(
    new Set(['DEPENDENCY', 'PACKAGE'])
);

function emptyAutoFixReport() {
    return {
        autoFixAvailable: false,
        autoFixApplied: false,
        fixes: []
    };
}

function normalizeKey(metadataType, metadataName) {
    if (!metadataType || !metadataName) {
        return null;
    }

    return `${metadataType}:${metadataName}`.toLowerCase();
}

function getDepType(dependency) {
    return dependency?.type || dependency?.metadataType || null;
}

function getDepName(dependency) {
    return dependency?.name || dependency?.metadataName || null;
}

function packageContains(deploymentPackage, metadataType, metadataName) {
    if (!deploymentPackage || !metadataType || !metadataName) {
        return false;
    }

    const key = normalizeKey(metadataType, metadataName);
    const items = [
        ...(deploymentPackage.metadata || []),
        ...(deploymentPackage.dependencies || [])
    ];

    return items.some((item) => {
        const type = item?.metadataType || item?.type;
        const name = item?.metadataName || item?.name;
        return normalizeKey(type, name) === key;
    });
}

function hasDeployableArtifact(dependency) {
    if (!dependency) {
        return false;
    }

    return (
        dependency.sourceExists === true ||
        dependency.artifactResolved === true ||
        Boolean(dependency.filePath)
    );
}

function resolveIncludeTarget(metadataType, metadataName) {
    if (!metadataType || !metadataName) {
        return null;
    }

    // ExternalCredentialPrincipal is not deployable — include parent ExternalCredential.
    if (metadataType === 'ExternalCredentialPrincipal') {
        const parentName = String(metadataName).split('-')[0];
        if (!parentName) {
            return null;
        }

        return {
            metadataType: 'ExternalCredential',
            metadataName: parentName
        };
    }

    if (!SUPPORTED_INCLUDE_TYPES.has(metadataType)) {
        return null;
    }

    return { metadataType, metadataName };
}

function findResolvedDependency(resolvedDependencies, metadataType, metadataName) {
    if (!Array.isArray(resolvedDependencies) || !metadataType || !metadataName) {
        return null;
    }

    const key = normalizeKey(metadataType, metadataName);

    return (
        resolvedDependencies.find((dependency) => {
            return normalizeKey(getDepType(dependency), getDepName(dependency)) === key;
        }) || null
    );
}

function buildFix({
    metadataType,
    metadataName,
    fixType,
    action,
    executed,
    successful,
    reason
}) {
    return {
        metadataType: metadataType || null,
        metadataName: metadataName || null,
        fixType,
        action: action || null,
        executed: executed === true,
        successful: successful === true,
        reason: reason || null
    };
}

/**
 * Identify INCLUDE_DISCOVERED_DEPENDENCY candidates from resolution recommendations
 * that already have resolved artifacts available.
 */
function collectIncludeCandidates({
    resolutionReport,
    resolvedDependencies,
    generatedDeploymentPackage
}) {
    const resolutions = Array.isArray(resolutionReport?.resolutions)
        ? resolutionReport.resolutions
        : [];
    const candidates = [];
    const seen = new Set();

    for (const resolution of resolutions) {
        if (!INCLUDE_RESOLUTION_TYPES.has(resolution?.resolutionType)) {
            continue;
        }

        const target = resolveIncludeTarget(
            resolution.metadataType,
            resolution.metadataName
        );

        if (!target) {
            continue;
        }

        const key = normalizeKey(target.metadataType, target.metadataName);
        if (!key || seen.has(key)) {
            continue;
        }

        if (
            packageContains(
                generatedDeploymentPackage,
                target.metadataType,
                target.metadataName
            )
        ) {
            continue;
        }

        const resolved = findResolvedDependency(
            resolvedDependencies,
            target.metadataType,
            target.metadataName
        );

        if (!resolved || !hasDeployableArtifact(resolved)) {
            continue;
        }

        if (resolved.action === 'BLOCK') {
            continue;
        }

        seen.add(key);
        candidates.push({
            metadataType: target.metadataType,
            metadataName: target.metadataName,
            resolved,
            reason:
                'Resolved dependency with source artifact is missing from the deployment package.'
        });
    }

    return candidates;
}

function adjustDependenciesForInclude(resolvedDependencies, candidates) {
    const includeKeys = new Set(
        candidates.map((candidate) =>
            normalizeKey(candidate.metadataType, candidate.metadataName)
        )
    );

    const source = Array.isArray(resolvedDependencies)
        ? resolvedDependencies
        : [];

    return source.map((dependency) => {
        const key = normalizeKey(getDepType(dependency), getDepName(dependency));

        if (!key || !includeKeys.has(key)) {
            return { ...dependency };
        }

        return {
            ...dependency,
            action: 'DEPLOY',
            selected: true,
            required: true
        };
    });
}

/**
 * Apply deterministic auto-fixes by reusing existing package/workspace services.
 *
 * @param {object} context
 * @param {object} [services] Optional service overrides for tests
 * @returns {Promise<object>} autoFixReport plus optional regenerated artifacts
 */
async function applyAutoFixes(context = {}, services = {}) {
    const generateDeploymentPackage =
        services.generateDeploymentPackage ||
        deploymentPackageService.generateDeploymentPackage;
    const generateManifest =
        services.generateManifest || packageXmlService.generateManifest;
    const buildDeploymentWorkspace =
        services.buildDeploymentWorkspace ||
        deploymentWorkspaceService.buildDeploymentWorkspace;

    const {
        resolutionReport = null,
        dependencyResolutionSummary = null,
        resolvedDependencies = null,
        deploymentPackage = null,
        generatedDeploymentPackage = null,
        generatedWorkspace = null,
        generatedManifest = null,
        selectedMetadata = null,
        repoUrl = null,
        sourceBranch = null,
        deploymentApiVersion = null,
        deploymentApiVersionPolicy = null
    } = context;

    // Prefer explicit resolvedDependencies; fall back to summary.decisions if present.
    const effectiveResolvedDependencies = Array.isArray(resolvedDependencies)
        ? resolvedDependencies
        : Array.isArray(dependencyResolutionSummary?.decisions)
          ? dependencyResolutionSummary.decisions
          : Array.isArray(dependencyResolutionSummary?.resolvedDependencies)
            ? dependencyResolutionSummary.resolvedDependencies
            : [];

    const candidates = collectIncludeCandidates({
        resolutionReport,
        resolvedDependencies: effectiveResolvedDependencies,
        generatedDeploymentPackage
    });

    if (!candidates.length) {
        return {
            ...emptyAutoFixReport(),
            generatedDeploymentPackage,
            generatedManifest,
            generatedWorkspace
        };
    }

    const fixes = [];
    const adjustedDependencies = adjustDependenciesForInclude(
        effectiveResolvedDependencies,
        candidates
    );

    const effectiveSelectedMetadata = Array.isArray(selectedMetadata)
        ? selectedMetadata
        : Array.isArray(deploymentPackage?.selectedMetadata)
          ? deploymentPackage.selectedMetadata
          : Array.isArray(deploymentPackage?.metadata)
            ? deploymentPackage.metadata
            : [];

    let regeneratedPackage = generatedDeploymentPackage;
    let regeneratedManifest = generatedManifest;
    let regeneratedWorkspace = generatedWorkspace;
    let packageRegenerated = false;
    let workspaceRebuilt = false;

    for (const candidate of candidates) {
        fixes.push(
            buildFix({
                metadataType: candidate.metadataType,
                metadataName: candidate.metadataName,
                fixType: FIX_TYPES.INCLUDE_DISCOVERED_DEPENDENCY,
                action: 'Included in deployment package',
                executed: false,
                successful: false,
                reason: candidate.reason
            })
        );
    }

    try {
        regeneratedPackage = generateDeploymentPackage({
            ...(deploymentPackage && typeof deploymentPackage === 'object'
                ? deploymentPackage
                : {}),
            selectedMetadata: effectiveSelectedMetadata,
            requiredDependencies: adjustedDependencies
        });

        regeneratedManifest = generateManifest(regeneratedPackage, {
            deploymentApiVersion,
            deploymentApiVersionPolicy: deploymentApiVersionPolicy
                ? {
                      ...deploymentApiVersionPolicy,
                      deploymentApiVersion:
                          deploymentApiVersion ||
                          deploymentApiVersionPolicy.deploymentApiVersion
                  }
                : undefined
        });

        packageRegenerated = true;

        for (const fix of fixes) {
            if (fix.fixType !== FIX_TYPES.INCLUDE_DISCOVERED_DEPENDENCY) {
                continue;
            }

            const included = packageContains(
                regeneratedPackage,
                fix.metadataType,
                fix.metadataName
            );

            fix.executed = true;
            fix.successful = included;
            if (!included) {
                fix.reason =
                    'Dependency was marked for inclusion but was not present after package regeneration.';
            }
        }

        fixes.push(
            buildFix({
                metadataType: null,
                metadataName: null,
                fixType: FIX_TYPES.REGENERATE_PACKAGE,
                action: 'Regenerated deployment package via existing package service',
                executed: true,
                successful: true,
                reason: 'Package regenerated after including discovered dependencies.'
            })
        );
    } catch (error) {
        for (const fix of fixes) {
            if (fix.fixType === FIX_TYPES.INCLUDE_DISCOVERED_DEPENDENCY) {
                fix.executed = true;
                fix.successful = false;
                fix.reason =
                    error?.message ||
                    'Package regeneration failed while applying include fixes.';
            }
        }

        fixes.push(
            buildFix({
                metadataType: null,
                metadataName: null,
                fixType: FIX_TYPES.REGENERATE_PACKAGE,
                action: 'Regenerated deployment package via existing package service',
                executed: true,
                successful: false,
                reason: error?.message || 'Package regeneration failed.'
            })
        );

        return {
            autoFixAvailable: true,
            autoFixApplied: false,
            fixes,
            generatedDeploymentPackage,
            generatedManifest,
            generatedWorkspace
        };
    }

    const canRebuildWorkspace =
        packageRegenerated && Boolean(repoUrl) && Boolean(sourceBranch);

    if (canRebuildWorkspace) {
        try {
            regeneratedWorkspace = await buildDeploymentWorkspace({
                generatedDeploymentPackage: regeneratedPackage,
                generatedManifest: regeneratedManifest,
                repoUrl,
                sourceBranch
            });
            workspaceRebuilt =
                regeneratedWorkspace?.workspaceCreated === true ||
                regeneratedWorkspace?.status === 'READY' ||
                regeneratedWorkspace?.status === 'PARTIAL';

            fixes.push(
                buildFix({
                    metadataType: null,
                    metadataName: null,
                    fixType: FIX_TYPES.REBUILD_WORKSPACE,
                    action: 'Rebuilt deployment workspace via existing workspace service',
                    executed: true,
                    successful: workspaceRebuilt,
                    reason: workspaceRebuilt
                        ? 'Workspace rebuilt after package regeneration.'
                        : regeneratedWorkspace?.skippedReason ||
                          'Workspace rebuild completed without a ready workspace.'
                })
            );
        } catch (error) {
            fixes.push(
                buildFix({
                    metadataType: null,
                    metadataName: null,
                    fixType: FIX_TYPES.REBUILD_WORKSPACE,
                    action: 'Rebuilt deployment workspace via existing workspace service',
                    executed: true,
                    successful: false,
                    reason: error?.message || 'Workspace rebuild failed.'
                })
            );
        }
    } else if (packageRegenerated) {
        fixes.push(
            buildFix({
                metadataType: null,
                metadataName: null,
                fixType: FIX_TYPES.REBUILD_WORKSPACE,
                action: 'Rebuilt deployment workspace via existing workspace service',
                executed: false,
                successful: false,
                reason:
                    'Workspace rebuild skipped because repository context was unavailable or workspace was previously gated.'
            })
        );
    }

    const includeSucceeded = fixes.some(
        (fix) =>
            fix.fixType === FIX_TYPES.INCLUDE_DISCOVERED_DEPENDENCY &&
            fix.successful === true
    );

    return {
        autoFixAvailable: true,
        autoFixApplied: includeSucceeded && packageRegenerated,
        fixes,
        generatedDeploymentPackage: regeneratedPackage,
        generatedManifest: regeneratedManifest,
        generatedWorkspace: regeneratedWorkspace
    };
}

module.exports = {
    applyAutoFixes,
    collectIncludeCandidates,
    FIX_TYPES,
    SUPPORTED_INCLUDE_TYPES,
    emptyAutoFixReport
};
