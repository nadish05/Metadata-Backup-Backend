const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('../decisionModel');
const {
    DISCOVERY_METHOD
} = require('../graphExpansion/structuralActionOverrideRelatedList.discoverer');

/**
 * Narrow resolver for bounded related-list CustomField prerequisites from
 * structural ActionOverride FlexiPages.
 */
const structuralActionOverrideRelatedListResolver = {
    id: 'structuralActionOverrideRelatedList',

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
                relationship:
                    dependency?.relationship || 'ActionOverrideRelatedList',
                reason: sourceMetadata
                    ? `Relationship field already exists in destination; structural FlexiPage ${sourceMetadata} does not require redeploying this prerequisite.`
                    : 'Relationship field already exists in destination; skip bounded structural related-list prerequisite.',
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
                relationship:
                    dependency?.relationship || 'ActionOverrideRelatedList',
                reason: sourceMetadata
                    ? `Relationship field is missing in destination and required by structural FlexiPage related list on ${sourceMetadata}.`
                    : 'Relationship field is missing in destination and required by a bounded structural related-list prerequisite.',
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
            relationship: dependency?.relationship || 'ActionOverrideRelatedList',
            reason:
                'Destination state unavailable; include bounded structural related-list field prerequisite.',
            source: 'RESOLVER'
        });
    }
};

module.exports = structuralActionOverrideRelatedListResolver;
