const axios = require('axios');

const deploymentReviewService = require('./deploymentReview.service');

const SUPPORTED_DEPENDENCY_TYPES = new Set([
    'ApexClass',
    'ApexTrigger',
    'CustomObject',
    'CustomField',
    'NamedCredential',
    'CustomMetadata',
    'CustomLabel'
]);

const BLOCKED_MESSAGES = {
    ApexClass: 'Apex Class not found in destination org.',
    ApexTrigger: 'Apex Trigger not found in destination org.',
    CustomObject: 'Custom Object not found in destination org.',
    CustomField: 'Custom Field not found in destination org.',
    NamedCredential: 'Named Credential not found in destination org.',
    CustomMetadata: 'Custom Metadata Type not found in destination org.',
    CustomLabel: 'Custom Label not found in destination org.'
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

function buildExcludedDependencyKeys(selectedMetadata) {
    const excluded = new Set();

    if (!Array.isArray(selectedMetadata)) {
        return excluded;
    }

    for (const item of selectedMetadata) {
        if (item?.metadataName && item?.metadataType) {
            excluded.add(`${item.metadataType}:${item.metadataName}`);
        }
    }

    return excluded;
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
    return type === 'ApexClass' || type === 'ApexTrigger';
}

async function collectRequiredDependencies(deploymentPackage) {
    const reviewResult =
        await deploymentReviewService.runDeploymentReview(deploymentPackage);

    const dependencyMap = new Map();

    for (const item of reviewResult.deploymentReview || []) {
        const requiredDependencies =
            item.dependencyAnalysis?.requiredDependencies || [];

        for (const dependency of requiredDependencies) {
            if (!dependency?.required || !dependency?.name || !dependency?.type) {
                continue;
            }

            const key = `${dependency.type}:${dependency.name}`;

            if (!dependencyMap.has(key)) {
                dependencyMap.set(key, {
                    name: dependency.name,
                    type: dependency.type
                });
            }
        }
    }

    return [...dependencyMap.values()];
}

function buildCustomFieldSoql(name) {
    if (name.includes('.')) {
        const [objectName, fieldName] = name.split('.');

        return (
            'SELECT Id FROM FieldDefinition ' +
            `WHERE QualifiedApiName = '${escapeSoql(fieldName)}' ` +
            `AND EntityDefinition.QualifiedApiName = '${escapeSoql(objectName)}' ` +
            'LIMIT 1'
        );
    }

    return (
        'SELECT Id FROM FieldDefinition ' +
        `WHERE QualifiedApiName = '${escapeSoql(name)}' ` +
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
    apiVersion
) {
    const { name, type } = dependency;

    if (!SUPPORTED_DEPENDENCY_TYPES.has(type)) {
        const status = 'WARNING';

        logDependencyCheck(name, type, status);

        return {
            name,
            type,
            exists: false,
            status,
            message: `${type} validation is not supported.`
        };
    }

    try {
        const validationResult = await dependencyExistsInDestination(
            type,
            name,
            instanceUrl,
            accessToken,
            apiVersion
        );

        logDependencyCheck(name, type, validationResult.status);

        const result = {
            name,
            type,
            exists: validationResult.exists,
            status: validationResult.status
        };

        if (validationResult.message) {
            result.message = validationResult.message;
        }

        return result;
    } catch (error) {
        console.error(`Dependency validation error for ${type}:${name}`);
        console.error(error.response?.data || error.message);

        const status = 'WARNING';

        logDependencyCheck(name, type, status);

        return {
            name,
            type,
            exists: false,
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
    deploymentPackage
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

    let requiredDependencies = [];

    try {
        requiredDependencies = await collectRequiredDependencies(
            deploymentPackage
        );
    } catch (error) {
        console.error('Dependency discovery failed.');
        console.error(error.message);

        logSection('Dependency Validation Complete');

        return {
            overallStatus: 'BLOCKED',
            results: [],
            message: error.message || 'Unable to discover required dependencies.'
        };
    }

    const excludedKeys = buildExcludedDependencyKeys(
        deploymentPackage?.selectedMetadata
    );

    const dependenciesToValidate = requiredDependencies.filter(
        (dependency) =>
            !excludedKeys.has(`${dependency.type}:${dependency.name}`)
    );

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
            apiVersion
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
