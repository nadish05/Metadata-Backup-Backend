const axios = require('axios');

const { getRegisteredResolvers } = require('./registry');
const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('./decisionModel');

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function escapeSoql(value) {
    return String(value).replace(/'/g, "\\'");
}

function buildSelectedMetadataKeys(selectedMetadata) {
    const keys = new Set();

    if (!Array.isArray(selectedMetadata)) {
        return keys;
    }

    for (const item of selectedMetadata) {
        if (item?.metadataType && item?.metadataName) {
            keys.add(`${item.metadataType}:${item.metadataName}`);
            keys.add(
                `${String(item.metadataType).toLowerCase()}:${String(
                    item.metadataName
                ).toLowerCase()}`
            );
        }
    }

    return keys;
}

function normalizeDependencyList(requiredDependencies) {
    if (!Array.isArray(requiredDependencies)) {
        return [];
    }

    const dependencyMap = new Map();

    for (const item of requiredDependencies) {
        if (!item?.name || !item?.type) {
            continue;
        }

        const key = `${item.type}:${item.name}`;

        if (dependencyMap.has(key)) {
            continue;
        }

        dependencyMap.set(key, item);
    }

    return [...dependencyMap.values()];
}

function createDefaultDecision(dependency) {
    const required = dependency.required !== false;
    const selected = dependency.selected !== false;
    const action =
        required && selected ? ACTIONS.DEPLOY : ACTIONS.SKIP;

    return createDecision({
        name: dependency.name,
        metadataType: dependency.type,
        action,
        required,
        selected,
        editable: dependency.editable === true,
        destinationState: DESTINATION_STATES.UNKNOWN,
        relationship: dependency.relationship || null,
        reason: 'Default deployment behavior preserved.',
        source: 'DEFAULT'
    });
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

async function queryCustomObjectExists(
    name,
    instanceUrl,
    accessToken,
    apiVersion
) {
    const soql =
        'SELECT QualifiedApiName FROM EntityDefinition ' +
        `WHERE QualifiedApiName = '${escapeSoql(name)}' LIMIT 1`;

    const response = await axios.get(
        `${instanceUrl}/services/data/v${apiVersion}/query/?q=${encodeURIComponent(
            soql
        )}`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return Array.isArray(response.data?.records) && response.data.records.length > 0;
}

async function buildDestinationStates(
    dependencies,
    resolvers,
    { accessToken, instanceUrl }
) {
    const destinationStates = new Map();
    const warnings = [];

    if (!accessToken || !instanceUrl) {
        return { destinationStates, warnings };
    }

    const customObjectNames = dependencies
        .filter((dependency) =>
            resolvers.some((resolver) => resolver.applies(dependency))
        )
        .filter((dependency) => dependency.type === 'CustomObject')
        .map((dependency) => dependency.name);

    if (!customObjectNames.length) {
        return { destinationStates, warnings };
    }

    let apiVersion;

    try {
        apiVersion = await getLatestApiVersion(instanceUrl, accessToken);
    } catch (error) {
        warnings.push(
            error?.message ||
                'Unable to resolve Salesforce API version for dependency resolution.'
        );
        return { destinationStates, warnings };
    }

    for (const name of customObjectNames) {
        const key = `CustomObject:${name}`;

        try {
            const exists = await queryCustomObjectExists(
                name,
                instanceUrl,
                accessToken,
                apiVersion
            );

            destinationStates.set(
                key,
                exists ? DESTINATION_STATES.EXISTS : DESTINATION_STATES.MISSING
            );
        } catch (error) {
            destinationStates.set(key, DESTINATION_STATES.UNKNOWN);
            warnings.push(
                `Unable to query destination state for CustomObject ${name}: ${
                    error?.message || 'unknown error'
                }`
            );
        }
    }

    return { destinationStates, warnings };
}

function buildSummary(decisions, warnings = []) {
    const summary = {
        analyzed: decisions.length,
        deploy: 0,
        reference: 0,
        skip: 0,
        block: 0,
        warnings: [...warnings]
    };

    for (const decision of decisions) {
        switch (decision.action) {
            case ACTIONS.DEPLOY:
                summary.deploy += 1;
                break;
            case ACTIONS.REFERENCE:
                summary.reference += 1;
                break;
            case ACTIONS.SKIP:
                summary.skip += 1;
                break;
            case ACTIONS.BLOCK:
                summary.block += 1;
                break;
            default:
                break;
        }
    }

    return summary;
}

function logResolutionResults(decisions, summary) {
    console.log('Dependencies analyzed:', summary.analyzed);

    for (const decision of decisions) {
        console.log('Dependency:', `${decision.metadataType}:${decision.name}`);
        console.log('Destination state:', decision.destinationState);
        console.log('Decision:', decision.action);
        console.log('Reason:', decision.reason);
        console.log('------------------------------------');
    }

    console.log('Summary:');
    console.log('Deploy:', summary.deploy);
    console.log('Reference:', summary.reference);
    console.log('Skip:', summary.skip);
    console.log('Block:', summary.block);
    console.log(
        'Warnings:',
        summary.warnings.length ? summary.warnings : '(none)'
    );

    logSection('Dependency Resolution Summary');
}

/**
 * Resolve dependency deployment actions.
 * Produces decisions only. Does not modify GitHub, workspace, or packages.
 *
 * @param {{
 *   requiredDependencies?: Array,
 *   selectedMetadata?: Array,
 *   accessToken?: string,
 *   instanceUrl?: string
 * }} options
 */
async function resolveDependencies({
    requiredDependencies,
    selectedMetadata,
    accessToken,
    instanceUrl
} = {}) {
    logSection('Dependency Resolution Engine');

    const dependencies = normalizeDependencyList(requiredDependencies);
    const resolvers = getRegisteredResolvers();
    const selectedMetadataKeys = buildSelectedMetadataKeys(selectedMetadata);

    if (!dependencies.length) {
        const summary = buildSummary([]);
        console.log('Dependencies analyzed: 0');
        logSection('Dependency Resolution Summary');

        return {
            decisions: [],
            resolvedDependencies: [],
            summary
        };
    }

    const { destinationStates, warnings } = await buildDestinationStates(
        dependencies,
        resolvers,
        { accessToken, instanceUrl }
    );

    const context = {
        selectedMetadataKeys,
        destinationStates,
        accessToken,
        instanceUrl
    };

    const decisions = [];

    for (const dependency of dependencies) {
        const resolver = resolvers.find((entry) => entry.applies(dependency));
        const decision = resolver
            ? resolver.resolve(dependency, context)
            : createDefaultDecision(dependency);

        decisions.push(decision);
    }

    const summary = buildSummary(decisions, warnings);
    logResolutionResults(decisions, summary);

    return {
        decisions,
        resolvedDependencies: decisions,
        summary
    };
}

module.exports = {
    resolveDependencies,
    ACTIONS,
    DESTINATION_STATES
};
