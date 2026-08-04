/**
 * Enterprise Deployment Preview (Phase 12.1).
 *
 * READ-ONLY summary of what will be deployed after compatibility
 * decisions. Does not modify package, readiness, gate, workspace, or CLI.
 */

function emptyPreview() {
    return {
        deploymentMode: 'FULL',
        estimatedRisk: 'LOW',
        summary: {
            deployableCount: 0,
            excludedCount: 0,
            blockingCount: 0,
            warningCount: 0
        },
        metadataBreakdown: [],
        deploymentStatistics: {
            totalMetadata: 0,
            deployableMetadata: 0,
            excludedMetadata: 0,
            blockedMetadata: 0
        },
        notes: []
    };
}

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function collectDeployableMembers(generatedDeploymentPackage) {
    const members = [];
    const items = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];

    for (const item of items) {
        const metadataType = getItemType(item);
        const metadataName = item?.metadataName || item?.name || null;

        if (!metadataType && !metadataName) {
            continue;
        }

        members.push({
            metadataType: metadataType || 'Unknown',
            metadataName
        });
    }

    return members;
}

function buildMetadataBreakdown(members) {
    const counts = new Map();

    for (const member of members) {
        const type = member.metadataType || 'Unknown';
        counts.set(type, (counts.get(type) || 0) + 1);
    }

    return Array.from(counts.entries())
        .map(([metadataType, count]) => ({ metadataType, count }))
        .sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count;
            }

            return String(a.metadataType).localeCompare(String(b.metadataType));
        });
}

function resolveDeploymentMode(excludedCount, blockingCount) {
    if (blockingCount > 0) {
        return 'BLOCKED';
    }

    if (excludedCount > 0) {
        return 'PARTIAL';
    }

    return 'FULL';
}

function resolveEstimatedRisk(excludedCount, blockingCount) {
    if (blockingCount > 0) {
        return 'HIGH';
    }

    if (excludedCount > 0) {
        return 'MEDIUM';
    }

    return 'LOW';
}

function hasMetadataType(breakdown, type) {
    return breakdown.some((entry) => entry.metadataType === type);
}

function buildNotes({
    deploymentMode,
    excludedCount,
    blockingCount,
    warningCount,
    metadataBreakdown,
    excludedComponents,
    deploymentCompatibilityAdvisor
}) {
    const notes = [];

    if (deploymentMode === 'BLOCKED' || blockingCount > 0) {
        notes.push(
            'Deployment is blocked until compatibility issues are resolved.'
        );
    } else if (blockingCount === 0) {
        notes.push('Deployment has no blocking dependencies.');
    }

    if (excludedCount > 0) {
        const hasFormulaExclusion = (excludedComponents || []).some(
            (item) =>
                item?.category === 'FORMULA_TYPE_CHANGE' ||
                item?.category === 'FORMULA_COMPILATION'
        );

        if (hasFormulaExclusion) {
            notes.push(
                'Deployment will exclude incompatible Formula fields.'
            );
        } else {
            notes.push(
                'Deployment will exclude incompatible metadata components.'
            );
        }
    }

    if (hasMetadataType(metadataBreakdown, 'ApexClass')) {
        notes.push('Deployment contains Apex metadata.');
    }

    if (hasMetadataType(metadataBreakdown, 'Flow')) {
        notes.push('Deployment contains Flow metadata.');
    }

    if (hasMetadataType(metadataBreakdown, 'LightningComponentBundle')) {
        notes.push('Deployment contains LWC bundles.');
    }

    if (warningCount > 0 && deploymentMode !== 'BLOCKED') {
        notes.push(
            `Deployment includes ${warningCount} compatibility warning${
                warningCount === 1 ? '' : 's'
            }.`
        );
    }

    const advisorRisk =
        deploymentCompatibilityAdvisor?.summary?.overallRisk || null;

    if (advisorRisk === 'HIGH' && deploymentMode !== 'BLOCKED') {
        notes.push(
            'Compatibility advisor reported high overall risk for this package.'
        );
    }

    if (deploymentMode === 'FULL' && excludedCount === 0 && blockingCount === 0) {
        notes.push('All package members are eligible for deployment.');
    }

    return notes;
}

/**
 * Build a read-only deployment preview from existing validation outputs.
 *
 * @param {{
 *   generatedDeploymentPackage?: object,
 *   deploymentReadiness?: object,
 *   deploymentCompatibilityAdvisor?: object,
 *   excludedComponents?: object[],
 *   blockingComponents?: object[],
 *   compatibilityWarnings?: object[]
 * }} input
 * @returns {object}
 */
function buildDeploymentPreview({
    generatedDeploymentPackage = null,
    deploymentReadiness = null,
    deploymentCompatibilityAdvisor = null,
    excludedComponents = null,
    blockingComponents = null,
    compatibilityWarnings = null
} = {}) {
    const excluded = Array.isArray(excludedComponents)
        ? excludedComponents
        : Array.isArray(deploymentReadiness?.excludedComponents)
          ? deploymentReadiness.excludedComponents
          : [];

    const blocking = Array.isArray(blockingComponents)
        ? blockingComponents
        : Array.isArray(deploymentReadiness?.blockingComponents)
          ? deploymentReadiness.blockingComponents
          : [];

    const warnings = Array.isArray(compatibilityWarnings)
        ? compatibilityWarnings
        : [];

    const deployableMembers = collectDeployableMembers(
        generatedDeploymentPackage
    );
    const metadataBreakdown = buildMetadataBreakdown(deployableMembers);

    const deployableCount = deployableMembers.length;
    const excludedCount = excluded.length;
    const blockingCount = blocking.length;
    const warningCount = warnings.length;

    const deploymentMode = resolveDeploymentMode(
        excludedCount,
        blockingCount
    );
    const estimatedRisk = resolveEstimatedRisk(excludedCount, blockingCount);

    return {
        deploymentMode,
        estimatedRisk,
        summary: {
            deployableCount,
            excludedCount,
            blockingCount,
            warningCount
        },
        metadataBreakdown,
        deploymentStatistics: {
            totalMetadata: deployableCount + excludedCount,
            deployableMetadata: deployableCount,
            excludedMetadata: excludedCount,
            blockedMetadata: blockingCount
        },
        notes: buildNotes({
            deploymentMode,
            excludedCount,
            blockingCount,
            warningCount,
            metadataBreakdown,
            excludedComponents: excluded,
            deploymentCompatibilityAdvisor
        })
    };
}

/**
 * Fail-safe wrapper — never throws to callers.
 */
function buildDeploymentPreviewSafe(input) {
    try {
        return buildDeploymentPreview(input);
    } catch (error) {
        return emptyPreview();
    }
}

module.exports = {
    emptyPreview,
    buildDeploymentPreview,
    buildDeploymentPreviewSafe,
    resolveDeploymentMode,
    resolveEstimatedRisk,
    buildMetadataBreakdown
};
