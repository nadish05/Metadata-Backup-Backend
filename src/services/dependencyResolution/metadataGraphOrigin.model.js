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
    SECONDARY_DEPENDENCY: 'SECONDARY_DEPENDENCY'
});

/**
 * Full CustomObject child enumeration (all fields / children) is only for
 * user-selected primary CustomObjects.
 *
 * @param {string|null|undefined} origin
 * @returns {boolean}
 */
function shouldEnumerateCustomObjectChildren(origin) {
    return (
        origin === METADATA_ORIGINS.PRIMARY_SELECTION ||
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
