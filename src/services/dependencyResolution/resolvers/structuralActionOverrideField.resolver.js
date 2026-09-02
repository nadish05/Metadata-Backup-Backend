const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('../decisionModel');
const {
    DISCOVERY_METHOD
} = require('../graphExpansion/structuralActionOverrideField.discoverer');

/**
 * Narrow resolver for FlexiPage structural actionOverride field prerequisites.
 * Does not apply to other CustomField dependencies.
 */
const structuralActionOverrideFieldResolver = {
    id: 'structuralActionOverrideField',

    applies(dependency) {
        return (
            dependency?.type === 'CustomField' &&
            dependency?.discoveryMethod === DISCOVERY_METHOD
        );
    },

    resolve(dependency, context = {}) {
        const name = String(dependency?.name || '').trim();
        const metadataType = 'CustomField';
        const destinationState =
            context.destinationStates?.get(`CustomField:${name}`) ||
            DESTINATION_STATES.UNKNOWN;
        const sourceMetadata = dependency?.sourceMetadata || null;

        if (destinationState === DESTINATION_STATES.EXISTS) {
            return createDecision({
                name,
                metadataType,
                action: ACTIONS.SKIP,
                required: true,
                selected: false,
                editable: true,
                destinationState,
                relationship: dependency?.relationship || 'Field',
                reason: sourceMetadata
                    ? `CustomField already exists in destination; structural FlexiPage ${sourceMetadata} does not require redeploying this field.`
                    : 'CustomField already exists in destination; skip structural FlexiPage field prerequisite.',
                source: 'RESOLVER'
            });
        }

        if (destinationState === DESTINATION_STATES.MISSING) {
            return createDecision({
                name,
                metadataType,
                action: ACTIONS.DEPLOY,
                required: true,
                selected: true,
                editable: true,
                destinationState,
                relationship: dependency?.relationship || 'Field',
                reason: sourceMetadata
                    ? `CustomField is missing in destination and referenced by structural FlexiPage ${sourceMetadata}.`
                    : 'CustomField is missing in destination and referenced by a structural FlexiPage action override.',
                source: 'RESOLVER'
            });
        }

        return createDecision({
            name,
            metadataType,
            action: ACTIONS.DEPLOY,
            required: dependency.required !== false,
            selected: dependency.selected !== false,
            editable: dependency.editable === true,
            destinationState,
            relationship: dependency?.relationship || 'Field',
            reason:
                'Destination state unavailable; include structural FlexiPage field prerequisite.',
            source: 'RESOLVER'
        });
    }
};

module.exports = structuralActionOverrideFieldResolver;
