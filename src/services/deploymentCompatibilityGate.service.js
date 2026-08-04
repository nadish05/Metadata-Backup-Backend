/**
 * Deployment Compatibility Gate (Phase 11.4).
 *
 * Consumes existing deploymentReadiness.readyForDeployment.
 * Does not recalculate exclusions, impact, or readiness.
 */

function shouldSkipDeploymentForCompatibility(deploymentReadiness) {
    return deploymentReadiness?.readyForDeployment === false;
}

function buildCompatibilitySkippedWorkspace() {
    return {
        workspacePath: null,
        workspaceCreated: false,
        packageXmlWritten: false,
        metadataCopied: 0,
        dependenciesCopied: 0,
        copiedFiles: 0,
        workspaceSize: '0 B',
        missingFiles: [],
        status: 'SKIPPED',
        skippedReason:
            'Workspace skipped because compatibility readiness reported blocking dependencies.'
    };
}

function buildCompatibilitySkipFields({
    deploymentReadiness,
    compatibilitySummary = null,
    excludedComponents = [],
    blockingComponents = []
} = {}) {
    return {
        success: false,
        deploymentSkipped: true,
        reason: 'BLOCKING_DEPENDENCIES',
        deploymentReadiness,
        compatibilitySummary: compatibilitySummary || {
            totalExcluded: Array.isArray(excludedComponents)
                ? excludedComponents.length
                : 0,
            totalRemaining: 0,
            excludedByCategory: {}
        },
        excludedComponents: Array.isArray(excludedComponents)
            ? excludedComponents
            : [],
        blockingComponents: Array.isArray(blockingComponents)
            ? blockingComponents
            : []
    };
}

module.exports = {
    shouldSkipDeploymentForCompatibility,
    buildCompatibilitySkippedWorkspace,
    buildCompatibilitySkipFields
};
