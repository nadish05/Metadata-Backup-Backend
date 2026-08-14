/**
 * AI Resolution Fact Pack (Phase 1).
 *
 * Deterministic CustomField source/destination facts for on-demand AI.
 * Advisory context only — never mutates deployment decisions or metadata.
 *
 * Reuses existing source CustomField shape + destination shape indexes.
 * Does not parse XML, describe orgs, or invent destination types.
 */

'use strict';

const {
    buildShapeKey,
    getShapeEntry
} = require('../destinationShape/destinationShape.model');

function getMetadataType(item) {
    return item?.metadataType || item?.type || item?.componentType || null;
}

function getMetadataName(item) {
    return (
        item?.metadataName ||
        item?.name ||
        item?.fullName ||
        item?.componentName ||
        null
    );
}

function failureKey(metadataType, metadataName) {
    if (!metadataType || !metadataName) {
        return null;
    }

    return `${metadataType}:${metadataName}`;
}

function unknownSide() {
    return {
        exists: null,
        type: null,
        calculated: null,
        label: null,
        details: {},
        confidence: 'UNKNOWN'
    };
}

/**
 * Serialize source CustomField shape Map for JSON / AI context.
 * Shape matches destination serializeDestinationShapeIndex.byType layout.
 *
 * @param {Map<string, object>|object|null} sourceShapeIndex
 * @returns {{ byType: object }}
 */
function serializeSourceCustomFieldShapeIndex(sourceShapeIndex) {
    const byType = { CustomField: {} };

    if (sourceShapeIndex instanceof Map) {
        for (const entry of sourceShapeIndex.values()) {
            const metadataName = entry?.metadataName;

            if (!metadataName) {
                continue;
            }

            byType.CustomField[metadataName] = entry;
        }

        return { byType };
    }

    if (
        sourceShapeIndex &&
        typeof sourceShapeIndex === 'object' &&
        sourceShapeIndex.byType
    ) {
        return {
            byType: {
                CustomField: {
                    ...(sourceShapeIndex.byType.CustomField || {})
                }
            }
        };
    }

    return { byType };
}

function lookupSourceEntry(sourceShapeIndex, metadataName) {
    if (!metadataName) {
        return null;
    }

    if (sourceShapeIndex instanceof Map) {
        return (
            sourceShapeIndex.get(`CustomField:${metadataName}`) ||
            sourceShapeIndex.get(buildShapeKey('CustomField', metadataName)) ||
            null
        );
    }

    const serialized = serializeSourceCustomFieldShapeIndex(sourceShapeIndex);
    return serialized.byType.CustomField[metadataName] || null;
}

function lookupDestinationEntry(destinationShapeIndex, metadataName) {
    if (!metadataName) {
        return null;
    }

    if (destinationShapeIndex?.shapes instanceof Map) {
        return getShapeEntry(
            destinationShapeIndex,
            'CustomField',
            metadataName
        );
    }

    const byType = destinationShapeIndex?.byType?.CustomField;

    if (byType && typeof byType === 'object') {
        return byType[metadataName] || null;
    }

    return null;
}

function buildSideFromSourceEntry(entry) {
    if (!entry) {
        return unknownSide();
    }

    const attributes = entry.attributes;

    if (!attributes || typeof attributes !== 'object') {
        return {
            ...unknownSide(),
            details: entry.warning ? { warning: entry.warning } : {}
        };
    }

    return {
        exists: true,
        type: attributes.mdapiType || attributes.type || null,
        calculated:
            typeof attributes.calculated === 'boolean'
                ? attributes.calculated
                : null,
        label: attributes.label || null,
        details: {
            soapType: attributes.type || null,
            mdapiType: attributes.mdapiType || null,
            length: attributes.length ?? null,
            precision: attributes.precision ?? null,
            scale: attributes.scale ?? null,
            required: attributes.required ?? null,
            referenceTo: attributes.referenceTo || [],
            picklistValues: attributes.picklistValues || null
        },
        confidence: 'HIGH'
    };
}

function buildSideFromDestinationEntry(entry) {
    if (!entry) {
        return unknownSide();
    }

    if (entry.queried !== true) {
        return {
            ...unknownSide(),
            details: entry.warning ? { warning: entry.warning } : {}
        };
    }

    if (entry.found !== true) {
        return {
            exists: false,
            type: null,
            calculated: null,
            label: null,
            details: entry.warning ? { warning: entry.warning } : {},
            confidence: 'HIGH'
        };
    }

    const attributes = entry.attributes;

    if (!attributes || typeof attributes !== 'object') {
        return {
            exists: true,
            type: null,
            calculated: null,
            label: null,
            details: entry.warning ? { warning: entry.warning } : {},
            confidence: 'UNKNOWN'
        };
    }

    return {
        exists: true,
        type: attributes.type || null,
        calculated:
            typeof attributes.calculated === 'boolean'
                ? attributes.calculated
                : null,
        label: attributes.label || null,
        details: {
            length: attributes.length ?? null,
            precision: attributes.precision ?? null,
            scale: attributes.scale ?? null,
            required: attributes.required ?? null,
            referenceTo: attributes.referenceTo || [],
            picklistValues: attributes.picklistValues || null,
            custom: attributes.custom ?? null
        },
        confidence: 'HIGH'
    };
}

function buildComparison(source, destination) {
    const sourceKnown = source?.confidence === 'HIGH' && source.type != null;
    const destKnown =
        destination?.confidence === 'HIGH' &&
        destination.exists === true &&
        destination.type != null;

    if (!sourceKnown || !destKnown) {
        return {
            conflictType: null,
            sourceType: source?.type ?? null,
            destinationType: destination?.type ?? null,
            sourceCalculated: source?.calculated ?? null,
            destinationCalculated: destination?.calculated ?? null,
            confidence: 'UNKNOWN'
        };
    }

    const typeMismatch =
        String(source.type).toLowerCase() !==
        String(destination.type).toLowerCase();
    const calculatedMismatch =
        typeof source.calculated === 'boolean' &&
        typeof destination.calculated === 'boolean' &&
        source.calculated !== destination.calculated;

    let conflictType = null;

    if (typeMismatch || calculatedMismatch) {
        conflictType = 'FIELD_TYPE_CONVERSION';
    }

    return {
        conflictType,
        sourceType: source.type,
        destinationType: destination.type,
        sourceCalculated: source.calculated,
        destinationCalculated: destination.calculated,
        confidence: 'HIGH'
    };
}

function collectCliProblems(deploymentDiagnostics, deployOutcome) {
    const problems = new Map();

    const lists = [
        deploymentDiagnostics?.componentFailures,
        deployOutcome?.deploymentDiagnostics?.componentFailures,
        deployOutcome?.failureDetails
    ];

    for (const list of lists) {
        if (!Array.isArray(list)) {
            continue;
        }

        for (const failure of list) {
            const metadataType = getMetadataType(failure);
            const metadataName = getMetadataName(failure);
            const key = failureKey(metadataType, metadataName);
            const problem =
                failure?.problem ||
                failure?.message ||
                failure?.problemType ||
                null;

            if (!key || !problem || problems.has(key)) {
                continue;
            }

            problems.set(key, String(problem));
        }
    }

    return problems;
}

function collectFailedCustomFields({
    failureClassification,
    deploymentDiagnostics,
    deployOutcome
}) {
    const items = [];
    const seen = new Set();

    function add(metadataType, metadataName) {
        if (metadataType !== 'CustomField' || !metadataName) {
            return;
        }

        const key = failureKey(metadataType, metadataName);

        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        items.push({ metadataType, metadataName, key });
    }

    for (const failure of failureClassification?.failures || []) {
        add(getMetadataType(failure), getMetadataName(failure));
    }

    for (const failure of deploymentDiagnostics?.componentFailures || []) {
        add(getMetadataType(failure), getMetadataName(failure));
    }

    for (const failure of deployOutcome?.deploymentDiagnostics
        ?.componentFailures || []) {
        add(getMetadataType(failure), getMetadataName(failure));
    }

    return items;
}

/**
 * Build additive AI-only fact packs for CustomField failures.
 *
 * @param {object} params
 * @returns {{ version: number, components: object[] }}
 */
function buildAiResolutionFactPack({
    failureClassification = null,
    deploymentDiagnostics = null,
    deployOutcome = null,
    sourceShapeIndex = null,
    destinationShapeIndex = null
} = {}) {
    const cliProblems = collectCliProblems(
        deploymentDiagnostics,
        deployOutcome
    );
    const failedFields = collectFailedCustomFields({
        failureClassification,
        deploymentDiagnostics,
        deployOutcome
    });

    const components = failedFields.map(({ metadataType, metadataName, key }) => {
        const classified =
            (failureClassification?.failures || []).find(
                (failure) =>
                    failureKey(
                        getMetadataType(failure),
                        getMetadataName(failure)
                    ) === key
            ) || null;

        const sourceEntry = lookupSourceEntry(sourceShapeIndex, metadataName);
        const destinationEntry = lookupDestinationEntry(
            destinationShapeIndex,
            metadataName
        );
        const source = buildSideFromSourceEntry(sourceEntry);
        const destination = buildSideFromDestinationEntry(destinationEntry);
        const comparison = buildComparison(source, destination);

        const pack = {
            metadata: {
                metadataType,
                metadataName
            },
            cliProblem: cliProblems.get(key) || null,
            classifiedReason: classified?.reason || null,
            source,
            destination,
            comparison
        };

        console.log(
            '[AI Fact Pack] CustomField facts ' +
                JSON.stringify({
                    metadataType,
                    metadataName,
                    sourceType: source.type,
                    destinationType: destination.type,
                    sourceCalculated: source.calculated,
                    destinationCalculated: destination.calculated,
                    conflictType: comparison.conflictType
                })
        );

        return pack;
    });

    return {
        version: 1,
        components
    };
}

/**
 * Find a fact pack for a metadata member.
 *
 * @param {object|null} factPack
 * @param {string|null} metadataType
 * @param {string|null} metadataName
 * @returns {object|null}
 */
function getComponentFactPack(factPack, metadataType, metadataName) {
    if (!factPack || !Array.isArray(factPack.components)) {
        return null;
    }

    const key = failureKey(metadataType, metadataName);

    if (!key) {
        return null;
    }

    return (
        factPack.components.find(
            (component) =>
                failureKey(
                    component?.metadata?.metadataType,
                    component?.metadata?.metadataName
                ) === key
        ) || null
    );
}

/**
 * Strip any accidental credential-like keys from a client-supplied fact pack.
 *
 * @param {object|null} raw
 * @returns {object|null}
 */
function sanitizeFactPackForAi(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const components = Array.isArray(raw.components) ? raw.components : [];

    return {
        version: typeof raw.version === 'number' ? raw.version : 1,
        components: components
            .filter(
                (component) =>
                    component?.metadata?.metadataType === 'CustomField' &&
                    component?.metadata?.metadataName
            )
            .map((component) => ({
                metadata: {
                    metadataType: 'CustomField',
                    metadataName: String(component.metadata.metadataName)
                },
                cliProblem:
                    typeof component.cliProblem === 'string'
                        ? component.cliProblem
                        : null,
                classifiedReason:
                    typeof component.classifiedReason === 'string'
                        ? component.classifiedReason
                        : null,
                source:
                    component.source && typeof component.source === 'object'
                        ? {
                              exists: component.source.exists ?? null,
                              type: component.source.type ?? null,
                              calculated: component.source.calculated ?? null,
                              label: component.source.label ?? null,
                              details:
                                  component.source.details &&
                                  typeof component.source.details === 'object'
                                      ? component.source.details
                                      : {},
                              confidence:
                                  component.source.confidence || 'UNKNOWN'
                          }
                        : unknownSide(),
                destination:
                    component.destination &&
                    typeof component.destination === 'object'
                        ? {
                              exists: component.destination.exists ?? null,
                              type: component.destination.type ?? null,
                              calculated:
                                  component.destination.calculated ?? null,
                              label: component.destination.label ?? null,
                              details:
                                  component.destination.details &&
                                  typeof component.destination.details ===
                                      'object'
                                      ? component.destination.details
                                      : {},
                              confidence:
                                  component.destination.confidence || 'UNKNOWN'
                          }
                        : unknownSide(),
                comparison:
                    component.comparison &&
                    typeof component.comparison === 'object'
                        ? {
                              conflictType:
                                  component.comparison.conflictType ?? null,
                              sourceType:
                                  component.comparison.sourceType ?? null,
                              destinationType:
                                  component.comparison.destinationType ?? null,
                              sourceCalculated:
                                  component.comparison.sourceCalculated ?? null,
                              destinationCalculated:
                                  component.comparison
                                      .destinationCalculated ?? null,
                              confidence:
                                  component.comparison.confidence || 'UNKNOWN'
                          }
                        : null
            }))
    };
}

module.exports = {
    buildAiResolutionFactPack,
    serializeSourceCustomFieldShapeIndex,
    sanitizeFactPackForAi,
    getComponentFactPack,
    unknownSide,
    buildComparison,
    buildSideFromSourceEntry,
    buildSideFromDestinationEntry
};
