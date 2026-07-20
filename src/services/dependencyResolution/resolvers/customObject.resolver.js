const {
    ACTIONS,
    DESTINATION_STATES,
    RELATIONSHIPS,
    createDecision
} = require('../decisionModel');

function normalizeObjectName(name) {
    return String(name || '').trim();
}

function resolveRelationship(dependency) {
    const raw = dependency?.relationship || dependency?.relationshipType;

    if (!raw) {
        return RELATIONSHIPS.LOOKUP;
    }

    const normalized = String(raw).toLowerCase().replace(/[^a-z]/g, '');

    if (
        normalized === 'masterdetail' ||
        normalized === 'masterdetaillookup' ||
        normalized === 'md'
    ) {
        return RELATIONSHIPS.MASTER_DETAIL;
    }

    if (normalized === 'lookup' || normalized === 'externallookup') {
        return RELATIONSHIPS.LOOKUP;
    }

    if (normalized === 'relatedobject' || normalized === 'parentobject') {
        return RELATIONSHIPS.RELATED_OBJECT;
    }

    return RELATIONSHIPS.LOOKUP;
}

function isSelectedCustomObject(dependency, context) {
    const name = normalizeObjectName(dependency?.name);
    const selectedKeys = context?.selectedMetadataKeys;

    if (!name || !selectedKeys) {
        return false;
    }

    return (
        selectedKeys.has(`CustomObject:${name}`) ||
        selectedKeys.has(`customobject:${name.toLowerCase()}`)
    );
}

/**
 * CustomObject decision resolver.
 * Classifies lookup / master-detail parent object dependencies only.
 * Does not merge, rewrite, or deploy metadata.
 */
const customObjectResolver = {
    id: 'customObject',

    applies(dependency) {
        return dependency?.type === 'CustomObject';
    },

    resolve(dependency, context = {}) {
        const name = normalizeObjectName(dependency?.name);
        const metadataType = 'CustomObject';
        const destinationState =
            context.destinationStates?.get(`CustomObject:${name}`) ||
            DESTINATION_STATES.UNKNOWN;
        const relationship = resolveRelationship(dependency);
        const userSelected = isSelectedCustomObject(dependency, context);

        if (userSelected) {
            return createDecision({
                name,
                metadataType,
                action: ACTIONS.DEPLOY,
                required: dependency.required !== false,
                selected: true,
                editable: false,
                destinationState,
                relationship,
                reason:
                    'CustomObject is explicitly selected for deployment.',
                source: 'RESOLVER'
            });
        }

        if (destinationState === DESTINATION_STATES.EXISTS) {
            return createDecision({
                name,
                metadataType,
                action: ACTIONS.REFERENCE,
                required: true,
                selected: false,
                editable: true,
                destinationState,
                relationship,
                reason:
                    `${relationship} target exists in destination; validate existence only and do not deploy object metadata.`,
                source: 'RESOLVER'
            });
        }

        if (destinationState === DESTINATION_STATES.MISSING) {
            if (relationship === RELATIONSHIPS.MASTER_DETAIL) {
                return createDecision({
                    name,
                    metadataType,
                    action: ACTIONS.BLOCK,
                    required: true,
                    selected: false,
                    editable: true,
                    destinationState,
                    relationship,
                    reason:
                        'Master-Detail parent object is missing in destination and was not selected for deployment.',
                    source: 'RESOLVER'
                });
            }

            return createDecision({
                name,
                metadataType,
                action: ACTIONS.DEPLOY,
                required: true,
                selected: true,
                editable: true,
                destinationState,
                relationship,
                reason:
                    `${relationship} target is missing in destination; include object metadata in the deployment package.`,
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
            destinationState: DESTINATION_STATES.UNKNOWN,
            relationship,
            reason:
                'Destination state unavailable; preserving existing auto-include behavior.',
            source: 'RESOLVER'
        });
    }
};

module.exports = customObjectResolver;
