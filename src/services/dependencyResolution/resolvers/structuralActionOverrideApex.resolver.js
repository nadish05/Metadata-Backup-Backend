const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('../decisionModel');
const {
    DISCOVERY_METHOD
} = require('../graphExpansion/structuralActionOverrideApex.discoverer');

/**
 * Terminal resolver for one-hop ApexClass prerequisites from bounded structural LWCs.
 */
const structuralActionOverrideApexResolver = {
    id: 'structuralActionOverrideApex',

    applies(dependency) {
        return (
            dependency?.type === 'ApexClass' &&
            dependency?.discoveryMethod === DISCOVERY_METHOD
        );
    },

    resolve(dependency, context = {}) {
        const name = String(dependency?.name || '').trim();
        const metadataType = 'ApexClass';
        const destinationState =
            context.destinationStates?.get(`ApexClass:${name}`) ||
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
                relationship: dependency?.relationship || 'LwcApexDependency',
                reason: sourceMetadata
                    ? `Apex class already exists in destination; structural Lightning component ${sourceMetadata} does not require redeploying this prerequisite.`
                    : 'Apex class already exists in destination; skip bounded structural Apex prerequisite.',
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
                relationship: dependency?.relationship || 'LwcApexDependency',
                reason: sourceMetadata
                    ? `Apex class is missing in destination and required by structural Lightning component ${sourceMetadata}.`
                    : 'Apex class is missing in destination and required by a bounded structural LWC prerequisite.',
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
            relationship: dependency?.relationship || 'LwcApexDependency',
            reason:
                'Destination state unavailable; include bounded structural Apex class prerequisite.',
            source: 'RESOLVER'
        });
    }
};

module.exports = structuralActionOverrideApexResolver;
