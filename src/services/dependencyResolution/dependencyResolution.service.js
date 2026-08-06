const { getRegisteredResolvers } = require('./registry');
const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('./decisionModel');
const {
    classifyDependency,
    classifyDependencies
} = require('./dependencyClassification.service');
const personAccountTrace = require('../personAccountTrace.temp');

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
 * Fold packageable, blocking discovered references into the dependency list.
 * Non-packageable classifications are excluded before resolution.
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

        const classification = classifyDependency(reference);

        // Classification gate: platform/runtime/unknown references stay out
        // of the deployable dependency list.
        if (!classification.packageable) {
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
            artifactResolved: reference.artifactResolved,
            classification: classification.classification,
            artifactRequired: classification.artifactRequired,
            packageable: classification.packageable,
            destinationValidationRequired:
                classification.destinationValidationRequired,
            defaultResolutionPolicy: classification.defaultResolutionPolicy,
            classificationReason: classification.reason
        });
    }

    return merged;
}

/**
 * Default decision from Dependency Classification — not "required ⇒ DEPLOY".
 */
function createDefaultDecision(dependency) {
    const required = dependency.required !== false;
    const selected = dependency.selected !== false;
    const classification =
        dependency.classification != null
            ? {
                  classification: dependency.classification,
                  artifactRequired: dependency.artifactRequired,
                  packageable: dependency.packageable,
                  destinationValidationRequired:
                      dependency.destinationValidationRequired,
                  defaultResolutionPolicy: dependency.defaultResolutionPolicy,
                  reason: dependency.classificationReason
              }
            : classifyDependency(dependency);

    let action = classification.defaultResolutionPolicy || ACTIONS.SKIP;

    if (!required || !selected) {
        action = ACTIONS.SKIP;
    }

    // Unknown / non-packageable must never auto-DEPLOY.
    if (action === ACTIONS.DEPLOY && classification.packageable !== true) {
        action = ACTIONS.SKIP;
    }

    return createDecision({
        name: dependency.name,
        metadataType: dependency.type,
        action,
        required,
        selected,
        editable: dependency.editable === true,
        destinationState: DESTINATION_STATES.UNKNOWN,
        relationship: dependency.relationship || null,
        reason:
            classification.reason ||
            'Default resolution derived from dependency classification.',
        source: 'CLASSIFICATION'
    });
}

function attachClassificationFields(decision, dependency) {
    const classification =
        dependency.classification != null
            ? {
                  classification: dependency.classification,
                  artifactRequired: dependency.artifactRequired,
                  packageable: dependency.packageable,
                  destinationValidationRequired:
                      dependency.destinationValidationRequired,
                  defaultResolutionPolicy: dependency.defaultResolutionPolicy,
                  classificationReason: dependency.classificationReason
              }
            : classifyDependency(dependency);

    return {
        ...decision,
        classification: classification.classification,
        artifactRequired:
            typeof decision.artifactRequired === 'boolean'
                ? decision.artifactRequired
                : classification.artifactRequired,
        packageable: classification.packageable,
        destinationValidationRequired:
            classification.destinationValidationRequired,
        defaultResolutionPolicy: classification.defaultResolutionPolicy,
        classificationReason:
            classification.classificationReason || classification.reason
    };
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
        console.log('Classification:', decision.classification || 'N/A');
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
 * Classification runs before decisions so defaults are policy-driven.
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

    const dependencies = classifyDependencies(
        normalizeDependencyList(
            mergeDeployableReferences(
                requiredDependencies,
                discoveredReferences
            )
        )
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
        // TEMP (Phase 15.3.1) — PersonAccount trace step 3 (incoming).
        personAccountTrace.logResolutionIncoming(dependency);

        const resolver = resolvers.find((entry) => entry.applies(dependency));

        // TEMP (Phase 15.3.1) — PersonAccount trace step 3 (resolver selection).
        personAccountTrace.logResolverSelection(dependency, resolver);

        const decision = resolver
            ? resolver.resolve(dependency, context)
            : createDefaultDecision(dependency);

        const resolvedDecision = attachClassificationFields(
            {
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
            },
            dependency
        );

        // TEMP (Phase 15.3.1) — PersonAccount trace step 3 (decision).
        personAccountTrace.logResolverDecision(dependency, resolvedDecision);

        decisions.push(resolvedDecision);
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
    createDefaultDecision,
    ACTIONS,
    DESTINATION_STATES
};
