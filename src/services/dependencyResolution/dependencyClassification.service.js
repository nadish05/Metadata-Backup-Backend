/**
 * Dependency Classification service.
 *
 * Sits between discovery and resolution. Assigns a classification and policy
 * to each dependency node so resolution and artifact.exists do not assume
 * every discovered node is packageable metadata.
 *
 * Rules are metadata-type driven. Existing platform registries are reused
 * where available (METADATA_TYPE_RULES, SYSTEM_CLASSES). No per-name hacks.
 */

const { METADATA_TYPE_RULES } = require('../../config/metadataTypes');
const {
    CLASSIFICATIONS,
    getClassificationPolicy
} = require('./dependencyClassification.model');

/**
 * Packageable Metadata API types known to this platform.
 * Built from METADATA_TYPE_RULES plus types used in production packages
 * that are not yet in that config map.
 */
const DEPLOYABLE_METADATA_TYPES = Object.freeze(
    new Set([
        ...Object.keys(METADATA_TYPE_RULES),
        'Layout',
        'AuraDefinitionBundle',
        'CustomLabels',
        'StaticResource',
        'RemoteSiteSetting',
        'ConnectedApp',
        'Queue',
        'Group',
        'Role',
        'CustomTab',
        'CustomApplication',
        'PathAssistant',
        'FlexiPage'
    ])
);

/**
 * Metadata types that represent runtime graph tokens, not Metadata API members.
 * Classification is by type — not by individual API names.
 */
const RUNTIME_REFERENCE_TYPES = Object.freeze(
    new Set(['RelationshipReference'])
);

/**
 * Metadata types that represent platform / standard UI surface references.
 * Not packageable from customer source.
 */
const PLATFORM_REFERENCE_TYPES = Object.freeze(
    new Set(['RelatedList'])
);

let systemApexClassSet = null;

/**
 * Lazy-load SYSTEM_CLASSES from the existing Apex analyzer registry.
 * Reuse only — does not change discovery behaviour.
 *
 * @returns {Set<string>}
 */
function getSystemApexClassSet() {
    if (systemApexClassSet) {
        return systemApexClassSet;
    }

    try {
        const analyzer = require('../deploymentReview/dependencyAnalyzer.service');
        const exported = analyzer.SYSTEM_CLASSES;

        if (exported instanceof Set) {
            systemApexClassSet = new Set(
                [...exported].map((name) => String(name).toLowerCase())
            );
            return systemApexClassSet;
        }
    } catch (error) {
        // Registry unavailable — Apex types fall through to type-only rules.
    }

    systemApexClassSet = new Set();
    return systemApexClassSet;
}

function getMetadataType(item) {
    return item?.metadataType || item?.type || null;
}

function getMetadataName(item) {
    return item?.metadataName || item?.name || null;
}

/**
 * Classify a single dependency / reference node.
 *
 * @param {object} item
 * @returns {{
 *   classification: string,
 *   artifactRequired: boolean,
 *   packageable: boolean,
 *   destinationValidationRequired: boolean,
 *   defaultResolutionPolicy: string,
 *   reason: string
 * }}
 */
function classifyDependency(item) {
    const metadataType = getMetadataType(item);
    const metadataName = getMetadataName(item);

    // Explicit non-deployable signal from discovery (e.g. RelatedList, std tabs).
    if (item?.deployable === false) {
        const policy = getClassificationPolicy(
            CLASSIFICATIONS.PLATFORM_REFERENCE
        );

        return {
            classification: CLASSIFICATIONS.PLATFORM_REFERENCE,
            ...policy,
            reason:
                'Discovery marked this node as non-deployable platform/runtime reference.'
        };
    }

    if (!metadataType) {
        const policy = getClassificationPolicy(CLASSIFICATIONS.UNKNOWN);

        return {
            classification: CLASSIFICATIONS.UNKNOWN,
            ...policy,
            reason: 'Dependency has no metadata type.'
        };
    }

    if (RUNTIME_REFERENCE_TYPES.has(metadataType)) {
        const policy = getClassificationPolicy(
            CLASSIFICATIONS.RUNTIME_REFERENCE
        );

        return {
            classification: CLASSIFICATIONS.RUNTIME_REFERENCE,
            ...policy,
            reason: `Metadata type ${metadataType} is a runtime reference, not packageable metadata.`
        };
    }

    if (PLATFORM_REFERENCE_TYPES.has(metadataType)) {
        const policy = getClassificationPolicy(
            CLASSIFICATIONS.PLATFORM_REFERENCE
        );

        return {
            classification: CLASSIFICATIONS.PLATFORM_REFERENCE,
            ...policy,
            reason: `Metadata type ${metadataType} is a platform reference.`
        };
    }

    // Reuse existing Apex system-class registry for PLATFORM vs user Apex.
    if (
        metadataType === 'ApexClass' &&
        metadataName &&
        getSystemApexClassSet().has(String(metadataName).toLowerCase())
    ) {
        const policy = getClassificationPolicy(
            CLASSIFICATIONS.PLATFORM_REFERENCE
        );

        return {
            classification: CLASSIFICATIONS.PLATFORM_REFERENCE,
            ...policy,
            reason:
                'Apex identifier matches the platform SYSTEM_CLASSES registry.'
        };
    }

    if (DEPLOYABLE_METADATA_TYPES.has(metadataType)) {
        const policy = getClassificationPolicy(
            CLASSIFICATIONS.DEPLOYABLE_METADATA
        );

        return {
            classification: CLASSIFICATIONS.DEPLOYABLE_METADATA,
            ...policy,
            reason: `Metadata type ${metadataType} is packageable deployable metadata.`
        };
    }

    const policy = getClassificationPolicy(CLASSIFICATIONS.UNKNOWN);

    return {
        classification: CLASSIFICATIONS.UNKNOWN,
        ...policy,
        reason: `Metadata type ${metadataType} is not a known deployable metadata type.`
    };
}

/**
 * Classify a list of dependency nodes. Attaches classification fields in place
 * on shallow copies (does not mutate inputs).
 *
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
function classifyDependencies(items = []) {
    if (!Array.isArray(items)) {
        return [];
    }

    return items.map((item) => {
        const classification = classifyDependency(item);

        return {
            ...item,
            classification: classification.classification,
            artifactRequired: classification.artifactRequired,
            packageable: classification.packageable,
            destinationValidationRequired:
                classification.destinationValidationRequired,
            defaultResolutionPolicy: classification.defaultResolutionPolicy,
            classificationReason: classification.reason
        };
    });
}

module.exports = {
    CLASSIFICATIONS,
    DEPLOYABLE_METADATA_TYPES,
    RUNTIME_REFERENCE_TYPES,
    PLATFORM_REFERENCE_TYPES,
    classifyDependency,
    classifyDependencies,
    getSystemApexClassSet
};
