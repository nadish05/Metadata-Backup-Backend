const axios = require('axios');

const SUPPORTED_DEPENDENCY_TYPES = new Set([
    'ApexClass',
    'ApexTrigger',
    'CustomObject',
    'CustomField',
    'NamedCredential',
    'CustomMetadata',
    'CustomLabel',
    'ListView'
]);

const BLOCKED_MESSAGES = {
    ApexClass: 'Apex Class not found in destination org.',
    ApexTrigger: 'Apex Trigger not found in destination org.',
    CustomObject: 'Custom Object not found in destination org.',
    CustomField: 'Custom Field not found in destination org.',
    NamedCredential: 'Named Credential not found in destination org.',
    CustomMetadata: 'Custom Metadata Type not found in destination org.',
    CustomLabel: 'Custom Label not found in destination org.',
    ListView: 'List View not found in destination org.'
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

function escapeSoql(value) {
    return String(value).replace(/'/g, "\\'");
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

async function getLatestApiVersion(instanceUrl, accessToken) {
    const response = await axios.get(`${instanceUrl}/services/data/`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        },
        timeout: 15000
    });

    const versions = response.data;

    if (!Array.isArray(versions) || !versions.length) {
        return '59.0';
    }

    return versions[versions.length - 1].version;
}

async function runSoqlQuery(
    instanceUrl,
    accessToken,
    apiVersion,
    soql,
    useToolingApi = false
) {
    const encodedQuery = encodeURIComponent(soql);
    const queryPath = useToolingApi ? 'tooling/query' : 'query';
    const response = await axios.get(
        `${instanceUrl}/services/data/v${apiVersion}/${queryPath}/?q=${encodedQuery}`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return response.data;
}

function usesToolingApi(type) {
    return (
        type === 'ApexClass' ||
        type === 'ApexTrigger' ||
        type === 'CustomField'
    );
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

function buildCustomFieldSoql(name) {
    if (name.includes('.')) {
        const [objectName, fieldName] = name.split('.');

        return (
            'SELECT DurableId FROM FieldDefinition ' +
            `WHERE QualifiedApiName = '${escapeSoql(fieldName)}' ` +
            `AND EntityDefinition.QualifiedApiName = '${escapeSoql(objectName)}' ` +
            'LIMIT 1'
        );
    }

    return (
        'SELECT DurableId FROM FieldDefinition ' +
        `WHERE QualifiedApiName = '${escapeSoql(name)}' ` +
        'LIMIT 1'
    );
}

function buildListViewSoql(name) {
    if (!name.includes('.')) {
        return null;
    }

    const [objectApiName, developerName] = name.split('.');

    if (!objectApiName || !developerName) {
        return null;
    }

    return (
        'SELECT Id, DeveloperName, SobjectType FROM ListView ' +
        `WHERE DeveloperName = '${escapeSoql(developerName)}' ` +
        `AND SobjectType = '${escapeSoql(objectApiName)}' ` +
        'LIMIT 1'
    );
}

function buildExistenceQuery(type, name) {
    const escapedName = escapeSoql(name);

    switch (type) {
        case 'ApexClass':
            return `SELECT Id FROM ApexClass WHERE Name = '${escapedName}' LIMIT 1`;

        case 'ApexTrigger':
            return `SELECT Id FROM ApexTrigger WHERE Name = '${escapedName}' LIMIT 1`;

        case 'CustomObject':
            return (
                'SELECT QualifiedApiName FROM EntityDefinition ' +
                `WHERE QualifiedApiName = '${escapedName}' LIMIT 1`
            );

        case 'CustomField':
            return buildCustomFieldSoql(name);

        case 'ListView':
            return buildListViewSoql(name);

        case 'NamedCredential':
            return (
                'SELECT Id FROM NamedCredential ' +
                `WHERE DeveloperName = '${escapedName}' LIMIT 1`
            );

        case 'CustomMetadata':
            return (
                'SELECT QualifiedApiName FROM EntityDefinition ' +
                `WHERE QualifiedApiName = '${escapedName}' LIMIT 1`
            );

        case 'CustomLabel':
            return (
                'SELECT Id FROM ExternalString ' +
                `WHERE Name = '${escapedName}' LIMIT 1`
            );

        default:
            return null;
    }
}

async function dependencyExistsInDestination(
    type,
    name,
    instanceUrl,
    accessToken,
    apiVersion
) {
    const soql = buildExistenceQuery(type, name);

    if (!soql) {
        return {
            exists: false,
            status: 'WARNING',
            message: `${type} validation is not supported.`
        };
    }

    const queryResult = await runSoqlQuery(
        instanceUrl,
        accessToken,
        apiVersion,
        soql,
        usesToolingApi(type)
    );

    const exists = (queryResult.totalSize || 0) > 0;

    if (exists) {
        return {
            exists: true,
            status: 'PASS'
        };
    }

    return {
        exists: false,
        status: 'BLOCKED',
        message: BLOCKED_MESSAGES[type] || `${type} not found in destination org.`
    };
}

async function validateSingleDependency(
    dependency,
    instanceUrl,
    accessToken,
    apiVersion,
    packageMetadataKeys
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

    try {
        const validationResult = await dependencyExistsInDestination(
            type,
            name,
            instanceUrl,
            accessToken,
            apiVersion
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
    } catch (error) {
        console.error(`Dependency validation error for ${type}:${name}`);
        console.error(error.response?.data || error.message);

        if (includedInDeploymentPackage) {
            logDependencyCheck(name, type, 'PASS');

            return {
                name,
                type,
                existsInDestination: false,
                includedInDeploymentPackage: true,
                status: 'PASS',
                resolution: PACKAGE_PASS_RESOLUTION
            };
        }

        const status = 'WARNING';

        logDependencyCheck(name, type, status);

        return {
            name,
            type,
            existsInDestination: false,
            includedInDeploymentPackage: false,
            status,
            message:
                error.response?.data?.[0]?.message ||
                error.message ||
                `Unable to validate ${type} in destination org.`
        };
    }
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
    generatedDeploymentPackage
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

    const apiVersion = await getLatestApiVersion(instanceUrl, accessToken);
    const results = [];

    for (const dependency of dependenciesToValidate) {
        const result = await validateSingleDependency(
            dependency,
            instanceUrl,
            accessToken,
            apiVersion,
            packageMetadataKeys
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
