const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('../decisionModel');
const {
    DISCOVERY_METHOD
} = require('../graphExpansion/structuralFormulaRelatedField.discoverer');

/**
 * Narrow resolver for bounded formula-related CustomField prerequisites.
 */
const structuralFormulaRelatedFieldResolver = {
    id: 'structuralFormulaRelatedField',

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
                relationship: dependency?.relationship || 'FormulaRelatedField',
                reason: sourceMetadata
                    ? `Formula-related CustomField already exists in destination; formula field ${sourceMetadata} does not require redeploying this prerequisite.`
                    : 'Formula-related CustomField already exists in destination; skip bounded formula prerequisite.',
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
                relationship: dependency?.relationship || 'FormulaRelatedField',
                reason: sourceMetadata
                    ? `Formula-related CustomField is missing in destination and required by formula field ${sourceMetadata}.`
                    : 'Formula-related CustomField is missing in destination and required by a bounded formula prerequisite.',
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
            relationship: dependency?.relationship || 'FormulaRelatedField',
            reason:
                'Destination state unavailable; include bounded formula-related CustomField prerequisite.',
            source: 'RESOLVER'
        });
    }
};

module.exports = structuralFormulaRelatedFieldResolver;
