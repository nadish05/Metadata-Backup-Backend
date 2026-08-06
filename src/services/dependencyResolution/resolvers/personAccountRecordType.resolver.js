const {
    ACTIONS,
    DESTINATION_STATES,
    createDecision
} = require('../decisionModel');

const METADATA_TYPE = 'RecordType';
const PERSON_ACCOUNT_PREFIX = 'PersonAccount.';

function isPersonAccountRecordType(dependency) {
    return (
        dependency?.type === METADATA_TYPE &&
        typeof dependency?.name === 'string' &&
        dependency.name.startsWith(PERSON_ACCOUNT_PREFIX) &&
        dependency.name.length > PERSON_ACCOUNT_PREFIX.length
    );
}

const personAccountRecordTypeResolver = {
    id: 'personAccountRecordType',

    applies(dependency) {
        return isPersonAccountRecordType(dependency);
    },

    resolve(dependency, context = {}) {
        const name = dependency.name;
        const destinationState =
            context.destinationStates?.get(`${METADATA_TYPE}:${name}`) ||
            DESTINATION_STATES.UNKNOWN;
        const baseDecision = {
            name,
            metadataType: METADATA_TYPE,
            required: dependency.required !== false,
            selected: false,
            editable: false,
            destinationState,
            relationship: dependency.relationship || null,
            source: 'RESOLVER'
        };

        if (destinationState === DESTINATION_STATES.EXISTS) {
            return {
                ...createDecision({
                    ...baseDecision,
                    action: ACTIONS.REFERENCE,
                    reason:
                        'Required Person Account RecordType exists in the destination; use the platform-managed destination component.'
                }),
                artifactRequired: false
            };
        }

        if (destinationState === DESTINATION_STATES.MISSING) {
            return {
                ...createDecision({
                    ...baseDecision,
                    action: ACTIONS.BLOCK,
                    reason:
                        'Required Person Account RecordType is unavailable in the destination. Enable Person Accounts and ensure the referenced Person Account RecordType exists.'
                }),
                artifactRequired: false
            };
        }

        return {
            ...createDecision({
                ...baseDecision,
                action: ACTIONS.BLOCK,
                reason:
                    'Unable to verify the required Person Account RecordType in the destination. Confirm Person Accounts are enabled and retry destination validation.'
            }),
            artifactRequired: false
        };
    }
};

module.exports = personAccountRecordTypeResolver;
