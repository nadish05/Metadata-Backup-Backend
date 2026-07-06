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
    dependencyValidation
}) {
    logSection('Deployment Readiness Evaluation Started');

    const summary = {
        destinationConnectivity: deploymentValidation?.status || 'BLOCKED',
        metadataValidation: metadataValidation?.overallStatus || 'PASS',
        dependencyValidation: dependencyValidation?.overallStatus || 'PASS'
    };

    const blockingIssues = [
        ...buildConnectivityBlockingIssues(deploymentValidation),
        ...buildMetadataBlockingIssues(metadataValidation),
        ...buildDependencyBlockingIssues(dependencyValidation)
    ];

    const warnings = buildDependencyWarnings(dependencyValidation);

    const hasBlocked =
        summary.destinationConnectivity === 'BLOCKED' ||
        summary.metadataValidation === 'BLOCKED' ||
        summary.dependencyValidation === 'BLOCKED';

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
        summary
    };
}

module.exports = {
    evaluateDeploymentReadiness
};
