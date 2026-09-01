const { ACTIONS } = require('../../dependencyResolution/decisionModel');

function resolveEffectiveDestinationState(
    decision,
    metadataType,
    metadataName,
    context = {}
) {
    if (
        decision?.destinationState &&
        decision.destinationState !== 'UNKNOWN'
    ) {
        return decision.destinationState;
    }

    const states = context.destinationStates;

    if (states instanceof Map) {
        const key = `${metadataType}:${metadataName}`;

        if (states.has(key)) {
            return states.get(key);
        }
    }

    return decision?.destinationState || 'UNKNOWN';
}

function canScheduleMissingDependency(decision) {
    return (
        decision?.action === ACTIONS.DEPLOY &&
        decision?.selected !== false &&
        (decision?.artifactResolved === true ||
            decision?.sourceExists === true)
    );
}

module.exports = {
    resolveEffectiveDestinationState,
    canScheduleMissingDependency
};
