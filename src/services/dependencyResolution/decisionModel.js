/**
 * Supported dependency deployment actions.
 * MERGE is reserved for a future phase and must not be applied.
 *
 * Reserved for Deployment Planner (Future Phase):
 * editable + destinationState decisions are the natural override surface for
 * future Deploy/Skip selections. Phase 4.1 does not apply planner overrides.
 */
const ACTIONS = Object.freeze({
    DEPLOY: 'DEPLOY',
    REFERENCE: 'REFERENCE',
    SKIP: 'SKIP',
    BLOCK: 'BLOCK',
    MERGE: 'MERGE'
});

const DESTINATION_STATES = Object.freeze({
    EXISTS: 'EXISTS',
    MISSING: 'MISSING',
    UNKNOWN: 'UNKNOWN',
    DRIFT_DETECTED: 'DRIFT_DETECTED'
});

const RELATIONSHIPS = Object.freeze({
    LOOKUP: 'Lookup',
    MASTER_DETAIL: 'MasterDetail',
    RELATED_OBJECT: 'RelatedObject'
});

function createDecision({
    name,
    metadataType,
    action,
    required = true,
    selected = true,
    editable = false,
    destinationState = DESTINATION_STATES.UNKNOWN,
    relationship = null,
    reason = '',
    source = 'DEFAULT'
}) {
    return {
        name,
        metadataType,
        type: metadataType,
        action,
        required,
        selected,
        editable,
        destinationState,
        relationship,
        reason,
        source
    };
}

module.exports = {
    ACTIONS,
    DESTINATION_STATES,
    RELATIONSHIPS,
    createDecision
};
