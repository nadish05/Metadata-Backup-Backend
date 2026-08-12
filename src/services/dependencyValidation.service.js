const SUPPORTED_DEPENDENCY_TYPES = new Set([
    'ApexClass',
    'ApexTrigger',
    'ApexPage',
    'CustomObject',
    'CustomField',
    'CustomTab',
    'CustomApplication',
    'CustomPermission',
    'NamedCredential',
    'CustomMetadata',
    'CustomLabel',
    'ListView',
    'FlexiPage',
    'LightningComponentBundle',
    'PermissionSet',
    'RecordType',
    'Flow'
]);

const BLOCKED_MESSAGES = {
    ApexClass: 'Apex Class not found in destination org.',
    ApexTrigger: 'Apex Trigger not found in destination org.',
    ApexPage: 'Apex Page not found in destination org.',
    CustomObject: 'Custom Object not found in destination org.',
    CustomField: 'Custom Field not found in destination org.',
    CustomTab: 'Custom Tab not found in destination org.',
    CustomApplication: 'Custom Application not found in destination org.',
    CustomPermission: 'Custom Permission not found in destination org.',
    NamedCredential: 'Named Credential not found in destination org.',
    CustomMetadata: 'Custom Metadata Type not found in destination org.',
    CustomLabel: 'Custom Label not found in destination org.',
    ListView: 'List View not found in destination org.',
    FlexiPage: 'FlexiPage not found in destination org.',
    LightningComponentBundle:
        'Lightning Component Bundle not found in destination org.',
    PermissionSet: 'Permission Set not found in destination org.',
    RecordType: 'Record Type not found in destination org.',
    Flow: 'Flow not found in destination org.'
};

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function logDependencyCheck(name, type, status) {
    console.log('Checking:');
    console.log(name);
    console.log('Type:');
    console.log(type);
    console.log('Result:');
    console.log(status);
    console.log('------------------------------------');
}

const PACKAGE_PASS_RESOLUTION =
    'Will be deployed as part of this deployment package.';
const PACKAGE_BLOCKED_RESOLUTION =
    'Add this dependency to the deployment package.';

function normalizeDependencyKey(type, name) {
    return `${type}:${String(name).toLowerCase()}`;
}

function buildPackageMetadataKeys(selectedMetadata) {
    const keys = new Set();

    if (!Array.isArray(selectedMetadata)) {
        return keys;
    }

    for (const item of selectedMetadata) {
        if (item?.metadataType && item?.metadataName) {
            keys.add(
                normalizeDependencyKey(
                    item.metadataType,
                    item.metadataName
                )
            );
        }
    }

    return keys;
}

function isIncludedInDeploymentPackage(type, name, packageMetadataKeys) {
    return packageMetadataKeys.has(normalizeDependencyKey(type, name));
}

/**
 * Build Dependency Validation rows from the generated deployment package.
 * This is a reporting inventory only — same source of truth as deploy.
 */
function collectDeploymentPackageInventory(generatedDeploymentPackage) {
    const inventoryMap = new Map();

    function addItem(type, name) {
        if (!type || !name) {
            return;
        }

        const key = `${type}:${name}`;

        if (!inventoryMap.has(key)) {
            inventoryMap.set(key, { name, type });
        }
    }

    for (const item of generatedDeploymentPackage?.metadata || []) {
        addItem(
            item.metadataType || item.type,
            item.metadataName || item.name
        );
    }

    for (const dependency of generatedDeploymentPackage?.dependencies || []) {
        addItem(
            dependency.type || dependency.metadataType,
            dependency.name || dependency.metadataName
        );
    }

    return [...inventoryMap.values()].sort((a, b) => {
        const typeCompare = a.type.localeCompare(b.type);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.name.localeCompare(b.name);
    });
}

/**
 * Map Destination Inventory state to Dependency Validation existence result.
 * UNKNOWN / missing entry → same behavior as the former query-failure path.
 */
function resolveExistenceFromInventory(type, name, destinationStates) {
    const key = `${type}:${name}`;
    const state =
        destinationStates instanceof Map
            ? destinationStates.get(key)
            : undefined;

    if (state === 'EXISTS') {
        return {
            exists: true,
            status: 'PASS'
        };
    }

    if (state === 'MISSING') {
        return {
            exists: false,
            status: 'BLOCKED',
            message:
                BLOCKED_MESSAGES[type] ||
                `${type} not found in destination org.`
        };
    }

    // UNKNOWN or no inventory entry — do not invent EXISTS/MISSING.
    return {
        exists: false,
        status: 'WARNING',
        message: `Unable to validate ${type} in destination org.`
    };
}

function validateSingleDependency(
    dependency,
    packageMetadataKeys,
    destinationStates
) {
    const { name, type } = dependency;
    const includedInDeploymentPackage = isIncludedInDeploymentPackage(
        type,
        name,
        packageMetadataKeys
    );

    if (!SUPPORTED_DEPENDENCY_TYPES.has(type)) {
        const status = includedInDeploymentPackage ? 'PASS' : 'WARNING';

        logDependencyCheck(name, type, status);

        const result = {
            name,
            type,
            existsInDestination: false,
            includedInDeploymentPackage,
            status
        };

        if (includedInDeploymentPackage) {
            result.resolution = PACKAGE_PASS_RESOLUTION;
        } else {
            result.message = `${type} validation is not supported.`;
        }

        return result;
    }

    const validationResult = resolveExistenceFromInventory(
        type,
        name,
        destinationStates
    );

    const existsInDestination = validationResult.exists;
    let status;

    if (existsInDestination) {
        status = 'PASS';
    } else if (includedInDeploymentPackage) {
        status = 'PASS';
    } else if (validationResult.status === 'WARNING') {
        status = 'WARNING';
    } else {
        status = 'BLOCKED';
    }

    logDependencyCheck(name, type, status);

    const result = {
        name,
        type,
        existsInDestination,
        includedInDeploymentPackage,
        status
    };

    if (status === 'PASS' && includedInDeploymentPackage && !existsInDestination) {
        result.resolution = PACKAGE_PASS_RESOLUTION;
    } else if (status === 'BLOCKED') {
        result.resolution = PACKAGE_BLOCKED_RESOLUTION;
        result.message =
            validationResult.message ||
            BLOCKED_MESSAGES[type] ||
            `${type} not found in destination org.`;
    } else if (validationResult.message && status === 'WARNING') {
        result.message = validationResult.message;
    }

    return result;
}

function resolveOverallStatus(results) {
    if (!results.length) {
        return 'PASS';
    }

    const hasBlocked = results.some((result) => result.status === 'BLOCKED');

    return hasBlocked ? 'BLOCKED' : 'PASS';
}

async function validateDependencies({
    accessToken,
    instanceUrl,
    deploymentPackage,
    generatedDeploymentPackage,
    destinationStates
}) {
    logSection('Dependency Validation Started');

    if (!accessToken || !instanceUrl) {
        console.log('Dependency validation blocked: missing destination credentials.');

        logSection('Dependency Validation Complete');

        return {
            overallStatus: 'BLOCKED',
            results: []
        };
    }

    // Reporting source of truth = generated deployment package (same as deploy).
    // Do not re-run Deployment Review to invent a separate dependency list.
    const packageInventory =
        generatedDeploymentPackage ||
        {
            metadata: deploymentPackage?.selectedMetadata || [],
            dependencies: deploymentPackage?.requiredDependencies || []
        };

    const dependenciesToValidate =
        collectDeploymentPackageInventory(packageInventory);

    const packageMetadataKeys = buildPackageMetadataKeys([
        ...(packageInventory.metadata || []),
        ...((packageInventory.dependencies || []).map((dependency) => ({
            metadataType: dependency.type || dependency.metadataType,
            metadataName: dependency.name || dependency.metadataName
        })))
    ]);

    if (!dependenciesToValidate.length) {
        logSection('Dependency Validation Complete');

        return {
            overallStatus: 'PASS',
            results: []
        };
    }

    const resolvedDestinationStates =
        destinationStates instanceof Map ? destinationStates : new Map();
    const results = [];

    for (const dependency of dependenciesToValidate) {
        const result = validateSingleDependency(
            dependency,
            packageMetadataKeys,
            resolvedDestinationStates
        );

        results.push(result);
    }

    const overallStatus = resolveOverallStatus(results);

    console.log(`Dependency validation status: ${overallStatus}`);
    logSection('Dependency Validation Complete');

    return {
        overallStatus,
        results
    };
}

module.exports = {
    validateDependencies
};
