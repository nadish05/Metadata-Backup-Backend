/**
 * Metadata graph origin model.
 *
 * Captures WHY a node entered the dependency graph so Deployment Review
 * can apply context-aware strategies (especially for CustomObject).
 */

const METADATA_ORIGINS = Object.freeze({
    PRIMARY_SELECTION: 'PRIMARY_SELECTION',
    DIRECT_DEPENDENCY: 'DIRECT_DEPENDENCY',
    RELATIONSHIP_TARGET: 'RELATIONSHIP_TARGET',
    SECONDARY_DEPENDENCY: 'SECONDARY_DEPENDENCY',
    CUSTOM_METADATA_PARENT: 'CUSTOM_METADATA_PARENT'
});

/**
 * Full CustomObject child enumeration (all fields / children) for:
 * - user-selected primary CustomObjects
 * - Custom Metadata Type parents discovered from CustomMetadata records
 *
 * RELATIONSHIP_TARGET / other non-primary origins remain relationship-only
 * so ordinary dependency CustomObjects do not over-package fields.
 *
 * @param {string|null|undefined} origin
 * @returns {boolean}
 */
function shouldEnumerateCustomObjectChildren(origin) {
    return (
        origin === METADATA_ORIGINS.PRIMARY_SELECTION ||
        origin === METADATA_ORIGINS.CUSTOM_METADATA_PARENT ||
        origin == null ||
        origin === undefined
    );
}

/**
 * Resolve origin for a review item. Defaults preserve legacy full review
 * when origin is absent (primary Deployment Review path).
 *
 * @param {object} item
 * @param {string|null} [fallback]
 * @returns {string}
 */
function resolveMetadataOrigin(item, fallback = METADATA_ORIGINS.PRIMARY_SELECTION) {
    if (item?.origin && Object.values(METADATA_ORIGINS).includes(item.origin)) {
        return item.origin;
    }

    return fallback;
}

module.exports = {
    METADATA_ORIGINS,
    shouldEnumerateCustomObjectChildren,
    resolveMetadataOrigin
};
