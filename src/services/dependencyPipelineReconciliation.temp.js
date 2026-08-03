/**
 * TEMPORARY DEBUG ONLY — Phase 10.18 Dependency Pipeline Reconciliation.
 * Remove after investigation. Does not change behavior.
 */

const TRACED_FIELDS = Object.freeze([
    'Booking__c.Experience_Name__c',
    'Booking__c.Number_of_Guests__c',
    'Guest_Review__c.Experience__c'
]);

/** @type {Map<string, Array<{stage:string,collection:string,variableName:string,present:boolean,identity:string|null,snapshot:object|null}>>} */
const fieldTimeline = new Map();

function getItemName(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    return item.name || item.metadataName || item.referencedObject || null;
}

function isTracedName(value) {
    return TRACED_FIELDS.includes(String(value || '').trim());
}

function objectIdentity(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    try {
        // Approximate identity without mutating the object.
        return `oid:${Object.prototype.toString.call(item)}:${getItemName(item)}:${item.metadataType || item.type || '?'}`;
    } catch (error) {
        return null;
    }
}

function summarizeItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    return {
        metadataType: item.metadataType || item.type || null,
        metadataName: getItemName(item),
        selected: item.selected,
        action: item.action,
        resolution: item.resolution || item.reason || item.source || null,
        source: item.source || item.discoveredBy || null,
        origin: item.origin || null,
        requiredBy: item.requiredBy || item.sourceMetadata || null,
        required: item.required,
        destinationState: item.destinationState,
        relationship: item.relationship,
        discoveryMethod: item.discoveryMethod,
        depth: item.depth,
        filePath: item.filePath || null,
        objectIdentity: objectIdentity(item)
    };
}

function findTracedInCollection(collection) {
    if (!Array.isArray(collection)) {
        return [];
    }

    return collection.filter((item) => isTracedName(getItemName(item)));
}

function recordTimelineEntry(fieldName, entry) {
    if (!fieldTimeline.has(fieldName)) {
        fieldTimeline.set(fieldName, []);
    }

    fieldTimeline.get(fieldName).push(entry);
}

/**
 * Log one named collection with full traced-field detail.
 */
function logPipelineCollection({
    stage,
    collectionName,
    variableName,
    collection,
    caller = null,
    method = null,
    note = null
} = {}) {
    const items = Array.isArray(collection) ? collection : [];
    const traced = findTracedInCollection(items);

    console.log('====================================================');
    console.log('DEPENDENCY PIPELINE RECONCILIATION');
    console.log('====================================================');
    console.log('Stage:');
    console.log(stage);
    console.log('Collection Name:');
    console.log(collectionName);
    console.log('Variable Name:');
    console.log(variableName);
    console.log('Array Length:');
    console.log(items.length);
    console.log('Is Array?:');
    console.log(Array.isArray(collection));

    if (caller) {
        console.log('Caller:');
        console.log(caller);
    }

    if (method) {
        console.log('Method:');
        console.log(method);
    }

    if (note) {
        console.log('Note:');
        console.log(note);
    }

    for (const fieldName of TRACED_FIELDS) {
        const matches = traced.filter(
            (item) => getItemName(item) === fieldName
        );
        const present = matches.length > 0;

        console.log(`Contains ${fieldName}?`);
        console.log(present ? 'YES' : 'NO');

        recordTimelineEntry(fieldName, {
            stage,
            collection: collectionName,
            variableName,
            present,
            identity: present ? objectIdentity(matches[0]) : null,
            snapshot: present ? summarizeItem(matches[0]) : null
        });

        if (present) {
            for (let index = 0; index < matches.length; index += 1) {
                const match = matches[index];
                console.log('Index:');
                console.log(index);
                console.log('metadataType:');
                console.log(match.metadataType || match.type || null);
                console.log('metadataName:');
                console.log(getItemName(match));
                console.log('selected:');
                console.log(match.selected);
                console.log('action:');
                console.log(match.action);
                console.log('resolution:');
                console.log(
                    match.resolution || match.reason || match.source || null
                );
                console.log('source:');
                console.log(match.source || match.discoveredBy || null);
                console.log('origin:');
                console.log(match.origin || null);
                console.log('requiredBy:');
                console.log(match.requiredBy || match.sourceMetadata || null);
                console.log('object identity:');
                console.log(objectIdentity(match));
                console.log('COMPLETE object:');
                try {
                    console.log(JSON.stringify(match, null, 2));
                } catch (error) {
                    console.log(match);
                }
            }
        }
    }

    console.log('====================================================');
}

function logTracedEnterOrLeave({
    stage,
    collectionName,
    event,
    item,
    caller = null
} = {}) {
    const name = getItemName(item);

    if (!isTracedName(name)) {
        return;
    }

    console.log('====================================================');
    console.log('DEPENDENCY PIPELINE RECONCILIATION — ENTER/LEAVE');
    console.log('====================================================');
    console.log('Stage:');
    console.log(stage);
    console.log('Collection Name:');
    console.log(collectionName);
    console.log('Event:');
    console.log(event);
    console.log('metadataName:');
    console.log(name);
    console.log('object identity:');
    console.log(objectIdentity(item));
    if (caller) {
        console.log('Caller:');
        console.log(caller);
    }
    console.log('COMPLETE object:');
    try {
        console.log(JSON.stringify(item, null, 2));
    } catch (error) {
        console.log(item);
    }
    console.log('====================================================');
}

function inferDroppedCollection(timeline) {
    let lastPresent = null;

    for (const entry of timeline) {
        if (entry.present) {
            lastPresent = entry;
            continue;
        }

        if (lastPresent && !entry.present) {
            return {
                firstMissing: `${entry.stage} / ${entry.collection} (${entry.variableName})`,
                previous: `${lastPresent.stage} / ${lastPresent.collection} (${lastPresent.variableName})`
            };
        }
    }

    if (timeline.every((entry) => entry.present)) {
        return {
            firstMissing: '(none — present in all logged collections)',
            previous: null
        };
    }

    return {
        firstMissing: '(never present in any logged collection)',
        previous: null
    };
}

function detectCopyOrMutation(timeline) {
    const presentEntries = timeline.filter(
        (entry) => entry.present && entry.identity
    );

    if (presentEntries.length < 2) {
        return {
            mutated: 'N/A',
            copied: 'N/A',
            renamed: 'N/A'
        };
    }

    const identities = new Set(presentEntries.map((entry) => entry.identity));
    const names = new Set(
        presentEntries
            .map((entry) => entry.snapshot?.metadataName)
            .filter(Boolean)
    );
    const actions = new Set(
        presentEntries.map((entry) => String(entry.snapshot?.action))
    );
    const selected = new Set(
        presentEntries.map((entry) => String(entry.snapshot?.selected))
    );

    return {
        mutated:
            actions.size > 1 || selected.size > 1
                ? 'YES (action/selected changed across stages)'
                : 'NO (action/selected stable in snapshots)',
        copied:
            identities.size > 1
                ? 'YES (object identity labels differ across stages — likely copies/rebuilds)'
                : 'NO (same identity label observed)',
        renamed: names.size > 1 ? 'YES' : 'NO'
    };
}

function buildFieldReport(fieldName) {
    const timeline = fieldTimeline.get(fieldName) || [];
    const drop = inferDroppedCollection(timeline);
    const copyInfo = detectCopyOrMutation(timeline);

    const byRole = {
        discoveredIn: null,
        movedTo: null,
        expandedInto: null,
        resolvedFrom: null,
        plannerUsed: null,
        packageUsed: null,
        manifestUsed: null
    };

    for (const entry of timeline) {
        if (!entry.present) {
            continue;
        }

        const label = `${entry.stage} :: ${entry.collection} [${entry.variableName}]`;

        if (/STAGE 1|discoverInternal/i.test(entry.stage + entry.collection)) {
            byRole.discoveredIn = byRole.discoveredIn || label;
        }

        if (/STAGE 3|Relationship|enrichedDependencies|discoveredRelationships/i.test(
            entry.stage + entry.collection + entry.variableName
        )) {
            byRole.movedTo = label;
        }

        if (/STAGE 5|STAGE 6|Graph|expand/i.test(entry.stage + entry.collection)) {
            byRole.expandedInto = label;
        }

        if (/STAGE 7|STAGE 8|Resolution|resolved/i.test(
            entry.stage + entry.collection + entry.variableName
        )) {
            byRole.resolvedFrom = label;
        }

        if (/STAGE 9|STAGE 10|Planner/i.test(entry.stage + entry.collection)) {
            byRole.plannerUsed = label;
        }

        if (/STAGE 11|STAGE 12|Package|generateDeploymentPackage/i.test(
            entry.stage + entry.collection
        )) {
            byRole.packageUsed = label;
        }

        if (/STAGE 13|Manifest|package.xml/i.test(entry.stage + entry.collection)) {
            byRole.manifestUsed = label;
        }
    }

    return {
        fieldName,
        byRole,
        drop,
        copyInfo,
        timeline
    };
}

function logFinalReconciliationReport() {
    console.log('====================================================');
    console.log('DEPENDENCY PIPELINE RECONCILIATION — FINAL REPORT');
    console.log('====================================================');

    for (const fieldName of TRACED_FIELDS) {
        const report = buildFieldReport(fieldName);

        console.log(fieldName);
        console.log('');
        console.log('Discovered In:');
        console.log(report.byRole.discoveredIn || '(not observed present)');
        console.log('Moved To:');
        console.log(report.byRole.movedTo || '(not observed present)');
        console.log('Expanded Into:');
        console.log(report.byRole.expandedInto || '(not observed present)');
        console.log('Resolved From:');
        console.log(report.byRole.resolvedFrom || '(not observed present)');
        console.log('Planner Used:');
        console.log(report.byRole.plannerUsed || '(not observed present)');
        console.log('Package Used:');
        console.log(report.byRole.packageUsed || '(not observed present)');
        console.log('Manifest Used:');
        console.log(report.byRole.manifestUsed || '(not observed present)');
        console.log('');
        console.log('First Collection Missing:');
        console.log(report.drop.firstMissing);
        console.log('Reason:');
        console.log(
            report.drop.previous
                ? `Present in ${report.drop.previous}, absent in ${report.drop.firstMissing}`
                : report.drop.firstMissing
        );
        console.log('Object mutated?');
        console.log(report.copyInfo.mutated);
        console.log('Object copied?');
        console.log(report.copyInfo.copied);
        console.log('Collection renamed?');
        console.log(report.copyInfo.renamed);
        console.log('----------------------------------------------------');
        console.log('Timeline (ordered):');
        for (const entry of report.timeline) {
            console.log(
                `${entry.present ? 'YES' : 'NO'} | ${entry.stage} | ${entry.collection} | ${entry.variableName}`
            );
        }
        console.log('====================================================');
    }
}

module.exports = {
    TRACED_FIELDS,
    logPipelineCollection,
    logTracedEnterOrLeave,
    logFinalReconciliationReport,
    findTracedInCollection,
    isTracedName,
    getItemName
};
