const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('../decisionModel');
const {
    DISCOVERY_METHOD
} = require('../graphExpansion/structuralActionOverrideComponent.discoverer');

/**
 * Narrow resolver for bounded LightningComponentBundle prerequisites from
 * structural ActionOverride FlexiPages.
 */
const structuralActionOverrideComponentResolver = {
    id: 'structuralActionOverrideComponent',

    applies(dependency) {
        return (
            dependency?.type === 'LightningComponentBundle' &&
            dependency?.discoveryMethod === DISCOVERY_METHOD
        );
    },

    resolve(dependency, context = {}) {
        const name = String(dependency?.name || '').trim();
        const metadataType = 'LightningComponentBundle';
        const destinationState =
            context.destinationStates?.get(
                `LightningComponentBundle:${name}`
            ) || DESTINATION_STATES.UNKNOWN;
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
                    dependency?.relationship || 'ActionOverrideComponent',
                reason: sourceMetadata
                    ? `Lightning component already exists in destination; structural FlexiPage ${sourceMetadata} does not require redeploying this prerequisite.`
                    : 'Lightning component already exists in destination; skip bounded structural LWC prerequisite.',
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
                    dependency?.relationship || 'ActionOverrideComponent',
                reason: sourceMetadata
                    ? `Lightning component is missing in destination and required by structural FlexiPage ${sourceMetadata}.`
                    : 'Lightning component is missing in destination and required by a bounded structural prerequisite.',
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
            relationship: dependency?.relationship || 'ActionOverrideComponent',
            reason:
                'Destination state unavailable; include bounded structural Lightning component prerequisite.',
            source: 'RESOLVER'
        });
    }
};

module.exports = structuralActionOverrideComponentResolver;
