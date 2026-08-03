/**
 * TEMPORARY DEBUG ONLY — Phase 10.13 Booking__c lifecycle trace.
 * Remove after investigation. Does not change behavior.
 */

const BOOKING_NAME = 'Booking__c';

function isBookingName(value) {
    return String(value || '').trim() === BOOKING_NAME;
}

function isBookingItem(item) {
    if (!item || typeof item !== 'object') {
        return false;
    }

    const name = item.name || item.metadataName || item.referencedObject || null;
    const type = item.type || item.metadataType || null;

    if (!isBookingName(name)) {
        return false;
    }

    // Prefer CustomObject matches; still accept Booking__c on any typed item.
    if (type && String(type) !== 'CustomObject') {
        return isBookingName(name);
    }

    return true;
}

function findBookingItems(collection) {
    if (!Array.isArray(collection)) {
        return [];
    }

    return collection.filter(isBookingItem);
}

function findBookingInObjectMap(mapOrObject) {
    if (!mapOrObject) {
        return [];
    }

    if (mapOrObject instanceof Map) {
        const matches = [];

        for (const [key, value] of mapOrObject.entries()) {
            if (isBookingName(key) || isBookingItem(value)) {
                matches.push(value);
            }
        }

        return matches;
    }

    if (typeof mapOrObject === 'object') {
        return findBookingItems(Object.values(mapOrObject));
    }

    return [];
}

/**
 * @param {{
 *   stage: string,
 *   collection?: string,
 *   items?: Array|object|Map|null,
 *   contains?: boolean|null,
 *   matches?: Array,
 *   caller?: string,
 *   method?: string,
 *   index?: string|number|null,
 *   extra?: object
 * }} options
 */
function logBookingTrace(options = {}) {
    const stage = options.stage || 'UNKNOWN';
    const collection = options.collection || null;
    const caller = options.caller || null;
    const method = options.method || null;
    const index = options.index != null ? options.index : null;
    const extra = options.extra || null;

    let matches = Array.isArray(options.matches) ? options.matches : null;

    if (!matches && options.items !== undefined) {
        if (Array.isArray(options.items)) {
            matches = findBookingItems(options.items);
        } else {
            matches = findBookingInObjectMap(options.items);
        }
    }

    if (!matches) {
        matches = [];
    }

    const contains =
        typeof options.contains === 'boolean'
            ? options.contains
            : matches.length > 0;

    console.log('====================================================');
    console.log('BOOKING TRACE');
    console.log('====================================================');
    console.log('Stage:');
    console.log(stage);

    if (collection) {
        console.log('Collection:');
        console.log(collection);
    }

    console.log('Contains Booking__c?');
    console.log(contains ? 'YES' : 'NO');

    if (contains && matches.length) {
        console.log('COMPLETE metadata object(s):');
        for (const match of matches) {
            try {
                console.log(JSON.stringify(match, null, 2));
            } catch (error) {
                console.log(match);
            }
        }
    }

    if (caller) {
        console.log('Caller:');
        console.log(caller);
    }

    if (method) {
        console.log('Method:');
        console.log(method);
    }

    if (index != null) {
        console.log('Index:');
        console.log(index);
    }

    if (extra && typeof extra === 'object') {
        console.log('Extra:');
        try {
            console.log(JSON.stringify(extra, null, 2));
        } catch (error) {
            console.log(extra);
        }
    }

    console.log('====================================================');
}

module.exports = {
    BOOKING_NAME,
    isBookingName,
    isBookingItem,
    findBookingItems,
    logBookingTrace
};
