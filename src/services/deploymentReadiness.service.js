function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function formatDependencyType(type) {
    return String(type || 'Dependency')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .trim();
}

function buildConnectivityBlockingIssues(deploymentValidation) {
    if (deploymentValidation?.status !== 'BLOCKED') {
        return [];
    }

    return [
        deploymentValidation.message ||
            'Destination connectivity validation blocked.'
    ];
}

function buildMetadataBlockingIssues(metadataValidation) {
    if (metadataValidation?.overallStatus !== 'BLOCKED') {
        return [];
    }

    const issues = (metadataValidation.results || [])
        .filter((result) => result.status === 'BLOCKED')
        .map((result) => {
            const metadataName =
                result.metadataName || result.metadataType || 'Metadata item';

            return `${metadataName} failed metadata validation.`;
        });

    if (issues.length) {
        return issues;
    }

    return ['Metadata validation blocked.'];
}

function buildDependencyBlockingIssues(dependencyValidation) {
    if (dependencyValidation?.overallStatus !== 'BLOCKED') {
        return [];
    }

    const issues = (dependencyValidation.results || [])
        .filter((result) => result.status === 'BLOCKED')
        .map((result) => {
            if (result.message) {
                return result.message;
            }

            return `${formatDependencyType(result.type)} ${result.name} is missing.`;
        });

    if (issues.length) {
        return issues;
    }

    if (dependencyValidation.message) {
        return [dependencyValidation.message];
    }

    return ['Dependency validation blocked.'];
}

function buildDependencyWarnings(dependencyValidation) {
    return (dependencyValidation?.results || [])
        .filter((result) => result.status === 'WARNING')
        .map((result) => {
            if (result.message) {
                return result.message;
            }

            return `${formatDependencyType(result.type)} ${result.name} could not be validated.`;
        });
}

function evaluateDeploymentReadiness({
    deploymentValidation,
    metadataValidation,
    dependencyValidation,
    deploymentApiVersionPolicy = null
}) {
    logSection('Deployment Readiness Evaluation Started');

    const summary = {
        destinationConnectivity: deploymentValidation?.status || 'BLOCKED',
        metadataValidation: metadataValidation?.overallStatus || 'PASS',
        dependencyValidation: dependencyValidation?.overallStatus || 'PASS',
        apiVersionPolicy:
            deploymentApiVersionPolicy?.compatible === false
                ? 'BLOCKED'
                : deploymentApiVersionPolicy
                  ? 'PASS'
                  : 'NOT_EVALUATED'
    };

    const blockingIssues = [
        ...buildConnectivityBlockingIssues(deploymentValidation),
        ...buildMetadataBlockingIssues(metadataValidation),
        ...buildDependencyBlockingIssues(dependencyValidation)
    ];

    if (deploymentApiVersionPolicy?.compatible === false) {
        blockingIssues.push(
            deploymentApiVersionPolicy.reason ||
                'Selected metadata API version is incompatible with the destination org.'
        );
    }

    const warnings = [
        ...buildDependencyWarnings(dependencyValidation),
        ...((deploymentApiVersionPolicy?.warnings || []).filter(Boolean))
    ];

    const hasBlocked =
        summary.destinationConnectivity === 'BLOCKED' ||
        summary.metadataValidation === 'BLOCKED' ||
        summary.dependencyValidation === 'BLOCKED' ||
        deploymentApiVersionPolicy?.compatible === false;

    let overallStatus;
    let canDeploy;

    if (hasBlocked) {
        overallStatus = 'BLOCKED';
        canDeploy = false;
    } else if (warnings.length) {
        overallStatus = 'READY_WITH_WARNINGS';
        canDeploy = true;
    } else {
        overallStatus = 'READY';
        canDeploy = true;
    }

    console.log(`Deployment readiness status: ${overallStatus}`);
    logSection('Deployment Readiness Evaluation Complete');

    return {
        overallStatus,
        canDeploy,
        blockingIssues,
        warnings,
        summary,
        deploymentApiVersionPolicy: deploymentApiVersionPolicy || null
    };
}

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function itemKey(type, name) {
    if (!type || !name) {
        return null;
    }

    return `${String(type)}:${String(name)}`;
}

function collectPackageComponents(filteredDeploymentPackage) {
    const items = [
        ...(filteredDeploymentPackage?.metadata || []),
        ...(filteredDeploymentPackage?.dependencies || [])
    ];
    const components = [];
    const seen = new Set();

    for (const item of items) {
        const metadataType = getItemType(item);
        const metadataName = getItemName(item);
        const key = itemKey(metadataType, metadataName);

        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        components.push({
            metadataType,
            metadataName
        });
    }

    return components;
}

/**
 * Phase 11.3 — Compatibility Deployment Readiness Planner.
 * Computes readyForDeployment from exclusions + blocking impact.
 * Does not cancel deployment or mutate the package.
 */
function planCompatibilityDeploymentReadiness({
    filteredDeploymentPackage,
    excludedComponents = [],
    blockingComponents = [],
    compatibilitySummary = null,
    blockingSummary = null,
    totalWarnings = null
} = {}) {
    const excluded = Array.isArray(excludedComponents)
        ? excludedComponents
        : [];
    const blocking = Array.isArray(blockingComponents)
        ? blockingComponents
        : [];

    const blockingKeys = new Set(
        blocking
            .map((item) => itemKey(item?.metadataType, item?.metadataName))
            .filter(Boolean)
    );

    const packageComponents = collectPackageComponents(
        filteredDeploymentPackage
    );

    const deployableComponents = packageComponents.filter((component) => {
        const key = itemKey(component.metadataType, component.metadataName);
        return key && !blockingKeys.has(key);
    });

    const readyForDeployment = blocking.length === 0;

    const resolvedExcludedCount =
        compatibilitySummary?.totalExcluded != null
            ? compatibilitySummary.totalExcluded
            : excluded.length;
    const resolvedBlockingCount =
        blockingSummary?.totalBlocking != null
            ? blockingSummary.totalBlocking
            : blocking.length;
    const resolvedWarningCount =
        totalWarnings != null
            ? Number(totalWarnings) || 0
            : resolvedExcludedCount + resolvedBlockingCount;

    const summary = {
        totalDeployable: deployableComponents.length,
        totalExcluded: resolvedExcludedCount,
        totalBlocking: resolvedBlockingCount,
        totalWarnings: resolvedWarningCount,
        // Convenience aliases for UI payloads.
        deployable: deployableComponents.length,
        excluded: resolvedExcludedCount,
        blocking: resolvedBlockingCount,
        warnings: resolvedWarningCount
    };

    return {
        readyForDeployment,
        deployableComponents,
        excludedComponents: excluded,
        blockingComponents: blocking,
        summary
    };
}

module.exports = {
    evaluateDeploymentReadiness,
    planCompatibilityDeploymentReadiness
};
