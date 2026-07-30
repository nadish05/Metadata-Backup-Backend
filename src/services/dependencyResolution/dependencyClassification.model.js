/**
 * Dependency Classification model.
 *
 * Classifies discovered dependency nodes before resolution / artifact checks.
 * Policies are classification-driven — not name-based ignore lists.
 */

const { ACTIONS } = require('./decisionModel');

const CLASSIFICATIONS = Object.freeze({
    DEPLOYABLE_METADATA: 'DEPLOYABLE_METADATA',
    PLATFORM_REFERENCE: 'PLATFORM_REFERENCE',
    RUNTIME_REFERENCE: 'RUNTIME_REFERENCE',
    DESTINATION_REFERENCE: 'DESTINATION_REFERENCE',
    UNKNOWN: 'UNKNOWN'
});

/**
 * Policy matrix per classification.
 * defaultResolutionPolicy is applied when no type-specific resolver matches.
 */
const CLASSIFICATION_POLICIES = Object.freeze({
    [CLASSIFICATIONS.DEPLOYABLE_METADATA]: Object.freeze({
        artifactRequired: true,
        packageable: true,
        destinationValidationRequired: true,
        defaultResolutionPolicy: ACTIONS.DEPLOY
    }),
    [CLASSIFICATIONS.PLATFORM_REFERENCE]: Object.freeze({
        artifactRequired: false,
        packageable: false,
        destinationValidationRequired: false,
        defaultResolutionPolicy: ACTIONS.SKIP
    }),
    [CLASSIFICATIONS.RUNTIME_REFERENCE]: Object.freeze({
        artifactRequired: false,
        packageable: false,
        destinationValidationRequired: false,
        defaultResolutionPolicy: ACTIONS.SKIP
    }),
    [CLASSIFICATIONS.DESTINATION_REFERENCE]: Object.freeze({
        artifactRequired: false,
        packageable: false,
        destinationValidationRequired: true,
        defaultResolutionPolicy: ACTIONS.REFERENCE
    }),
    [CLASSIFICATIONS.UNKNOWN]: Object.freeze({
        artifactRequired: false,
        packageable: false,
        destinationValidationRequired: false,
        defaultResolutionPolicy: ACTIONS.SKIP
    })
});

function getClassificationPolicy(classification) {
    return (
        CLASSIFICATION_POLICIES[classification] ||
        CLASSIFICATION_POLICIES[CLASSIFICATIONS.UNKNOWN]
    );
}

module.exports = {
    CLASSIFICATIONS,
    CLASSIFICATION_POLICIES,
    getClassificationPolicy
};
