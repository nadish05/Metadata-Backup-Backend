/**
 * TEMPORARY DEBUG ONLY — Phase 10.17 CustomField lifecycle trace.
 * Remove after investigation. Does not change behavior.
 */

const TRACED_CUSTOM_FIELDS = Object.freeze([
    'Booking__c.Experience_Name__c',
    'Booking__c.Number_of_Guests__c',
    'Guest_Review__c.Experience__c'
]);

const LIFECYCLE_STAGES = Object.freeze([
    'Discovery',
    'Relationship',
    'Graph',
    'Resolution',
    'Planner',
    'Package',
    'Manifest'
]);

/** @type {Map<string, Record<string, boolean|null>>} */
const lifecyclePresence = new Map();

function ensureLifecycleRow(fieldName) {
    if (!lifecyclePresence.has(fieldName)) {
        const row = {};

        for (const stage of LIFECYCLE_STAGES) {
            row[stage] = null;
        }

        lifecyclePresence.set(fieldName, row);
    }

    return lifecyclePresence.get(fieldName);
}

function getItemName(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    return item.name || item.metadataName || item.referencedObject || null;
}

function isTracedCustomFieldName(value) {
    return TRACED_CUSTOM_FIELDS.includes(String(value || '').trim());
}

function isTracedCustomFieldItem(item) {
    return isTracedCustomFieldName(getItemName(item));
}

function findTracedItems(collection) {
    if (!Array.isArray(collection)) {
        return [];
    }

    return collection.filter(isTracedCustomFieldItem);
}

function collectionContainsField(collection, fieldName) {
    if (!Array.isArray(collection)) {
        return false;
    }

    return collection.some((item) => getItemName(item) === fieldName);
}

function recordStagePresence(stage, collection, options = {}) {
    if (!LIFECYCLE_STAGES.includes(stage)) {
        return;
    }

    const accumulate = options.accumulate === true;

    for (const fieldName of TRACED_CUSTOM_FIELDS) {
        const row = ensureLifecycleRow(fieldName);
        const present = collectionContainsField(collection, fieldName);

        if (accumulate) {
            if (present) {
                row[stage] = true;
            } else if (row[stage] == null) {
                row[stage] = false;
            }
        } else {
            row[stage] = present;
        }
    }
}

function findDroppedAt(row) {
    let lastYes = null;

    for (const stage of LIFECYCLE_STAGES) {
        if (row[stage] === true) {
            lastYes = stage;
            continue;
        }

        if (row[stage] === false) {
            return lastYes
                ? `${stage} (after ${lastYes})`
                : `${stage} (never present)`;
        }
    }

    if (LIFECYCLE_STAGES.every((stage) => row[stage] === true)) {
        return '(none — present through Manifest)';
    }

    return '(incomplete — some stages not recorded)';
}

function yesNo(value) {
    if (value === true) {
        return 'YES';
    }

    if (value === false) {
        return 'NO';
    }

    return 'N/A';
}

/**
 * Log presence of traced CustomFields in a collection.
 *
 * @param {{
 *   stage: string,
 *   collection?: string,
 *   items?: Array|null,
 *   caller?: string,
 *   method?: string,
 *   lifecycleStage?: string|null,
 *   includeResolutionDetails?: boolean,
 *   extra?: object
 * }} options
 */
function logCustomFieldLifecycleTrace(options = {}) {
    const stage = options.stage || 'UNKNOWN';
    const collection = options.collection || null;
    const items = Array.isArray(options.items) ? options.items : [];
    const caller = options.caller || null;
    const method = options.method || null;
    const lifecycleStage = options.lifecycleStage || null;
    const includeResolutionDetails = options.includeResolutionDetails === true;
    const extra = options.extra || null;

    if (lifecycleStage) {
        recordStagePresence(lifecycleStage, items, {
            accumulate: options.accumulate === true
        });
    }

    console.log('====================================================');
    console.log('CUSTOMFIELD LIFECYCLE TRACE');
    console.log('====================================================');
    console.log('Stage:');
    console.log(stage);

    if (collection) {
        console.log('Collection:');
        console.log(collection);
    }

    for (const fieldName of TRACED_CUSTOM_FIELDS) {
        const matches = items.filter((item) => getItemName(item) === fieldName);
        const present = matches.length > 0;

        console.log(`Contains ${fieldName}?`);
        console.log(present ? 'YES' : 'NO');

        if (present) {
            console.log('COMPLETE metadata object(s):');
            for (const match of matches) {
                try {
                    console.log(JSON.stringify(match, null, 2));
                } catch (error) {
                    console.log(match);
                }
            }

            if (includeResolutionDetails) {
                for (const match of matches) {
                    console.log('action:');
                    console.log(match.action ?? '(none)');
                    console.log('destinationState:');
                    console.log(match.destinationState ?? '(none)');
                    console.log('selected:');
                    console.log(match.selected ?? '(none)');
                    console.log('resolution:');
                    console.log(
                        match.resolution ??
                            match.reason ??
                            match.source ??
                            '(none)'
                    );
                }
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

function logFinalCustomFieldLifecycleSummary() {
    console.log('====================================================');
    console.log('CUSTOMFIELD LIFECYCLE TRACE — FINAL SUMMARY');
    console.log('====================================================');

    for (const fieldName of TRACED_CUSTOM_FIELDS) {
        const row = ensureLifecycleRow(fieldName);

        console.log(fieldName);
        console.log('');
        console.log(`Discovery            ${yesNo(row.Discovery)}`);
        console.log(`Relationship         ${yesNo(row.Relationship)}`);
        console.log(`Graph                ${yesNo(row.Graph)}`);
        console.log(`Resolution           ${yesNo(row.Resolution)}`);
        console.log(`Planner              ${yesNo(row.Planner)}`);
        console.log(`Package              ${yesNo(row.Package)}`);
        console.log(`Manifest             ${yesNo(row.Manifest)}`);
        console.log('');
        console.log('Dropped At:');
        console.log(findDroppedAt(row));
        console.log('----------------------------------------------------');
    }

    console.log('====================================================');
}

module.exports = {
    TRACED_CUSTOM_FIELDS,
    findTracedItems,
    isTracedCustomFieldName,
    collectionContainsField,
    recordStagePresence,
    logCustomFieldLifecycleTrace,
    logFinalCustomFieldLifecycleSummary
};
