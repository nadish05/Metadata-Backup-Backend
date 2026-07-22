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

/**
 * Fold deployable, blocking discovered references into the dependency list.
 * Same resolution path as every other required dependency — no separate layer.
 */
function mergeDeployableReferences(
    requiredDependencies = [],
    discoveredReferences = []
) {
    if (!Array.isArray(discoveredReferences) || !discoveredReferences.length) {
        return requiredDependencies;
    }

    const merged = [...(requiredDependencies || [])];

    for (const reference of discoveredReferences) {
        if (reference?.deployable !== true || reference?.blocking !== true) {
            continue;
        }

        const name = reference.name;
        const type = reference.metadataType || reference.type;

        if (!name || !type) {
            continue;
        }

        merged.push({
            name,
            type,
            required: true,
            selected: true,
            relationship:
                reference.referenceType || reference.relationship || null,
            reason:
                reference.reason ||
                'Deployable reference discovered during metadata reference discovery.',
            source: reference.discoveredBy || 'REFERENCE_DISCOVERY',
            filePath: reference.filePath || null,
            sourceExists: reference.sourceExists,
            artifactResolved: reference.artifactResolved
        });
    }

    return merged;
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
 * Deployable, blocking discovered references participate in the same
 * dependency list and decision flow as requiredDependencies.
 *
 * Destination existence comes from the Destination Inventory Builder via
 * destinationStates (toDestinationStateMap → context.destinationStates).
 *
 * @param {{
 *   requiredDependencies?: Array,
 *   discoveredReferences?: Array,
 *   selectedMetadata?: Array,
 *   accessToken?: string,
 *   instanceUrl?: string,
 *   destinationStates?: Map<string, string>,
 *   destinationStateWarnings?: string[]
 * }} options
 */
async function resolveDependencies({
    requiredDependencies,
    discoveredReferences,
    selectedMetadata,
    accessToken,
    instanceUrl,
    destinationStates,
    destinationStateWarnings
} = {}) {
    logSection('Dependency Resolution Engine');

    const dependencies = normalizeDependencyList(
        mergeDeployableReferences(requiredDependencies, discoveredReferences)
    );
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

    const resolvedDestinationStates =
        destinationStates instanceof Map ? destinationStates : new Map();
    const warnings = Array.isArray(destinationStateWarnings)
        ? [...destinationStateWarnings]
        : [];

    const context = {
        selectedMetadataKeys,
        destinationStates: resolvedDestinationStates,
        accessToken,
        instanceUrl
    };

    const decisions = [];

    for (const dependency of dependencies) {
        const resolver = resolvers.find((entry) => entry.applies(dependency));
        const decision = resolver
            ? resolver.resolve(dependency, context)
            : createDefaultDecision(dependency);

        // Preserve repository artifact enrichment for Workspace / Compatibility.
        decisions.push({
            ...decision,
            filePath: dependency.filePath || decision.filePath || null,
            sourceExists:
                dependency.sourceExists != null
                    ? dependency.sourceExists
                    : decision.sourceExists,
            artifactResolved:
                dependency.artifactResolved != null
                    ? dependency.artifactResolved
                    : decision.artifactResolved
        });
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
    mergeDeployableReferences,
    ACTIONS,
    DESTINATION_STATES
};
