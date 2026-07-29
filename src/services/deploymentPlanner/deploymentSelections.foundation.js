/**
 * Deployment Planner foundation.
 *
 * Extracts and normalizes optional deploymentSelections from the request.
 * Application of those preferences onto the decision model is handled by
 * deploymentPlanner.service (after Dependency Resolution, before Compatibility).
 *
 * This module does not change Compatibility, Package Generation, Workspace,
 * package.xml, or Salesforce CLI behaviour by itself.
 *
 * When no selections are present, callers receive an empty list.
 */

const ALLOWED_CHOICES = new Set(['DEPLOY', 'SKIP']);

/**
 * TEMPORARY DIAGNOSTIC — remove after deploymentSelections origin investigation.
 * Does not mutate data or change return values.
 */
function logDeploymentSelectionDiagnostic({
    event = 'DEPLOYMENT SELECTION CREATED',
    caller,
    file,
    method,
    selections,
    lastAddedEntry = null
}) {
    console.log('------------------------------------------');
    console.log(event);
    console.log('Caller');
    console.log(caller);
    console.log('File');
    console.log(file);
    console.log('Method');
    console.log(method);
    console.log('Current Selection Count');
    console.log(Array.isArray(selections) ? selections.length : 0);
    console.log('Last Added Entry');
    console.log(JSON.stringify(lastAddedEntry, null, 2));
    console.log('------------------------------------------');
}

/**
 * Normalize a single selection entry into a stable internal shape.
 * Invalid or incomplete entries are discarded.
 *
 * @param {object} item
 * @returns {{ metadataType: string, metadataName: string, choice: 'DEPLOY'|'SKIP' }|null}
 */
function normalizeSelectionItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const metadataType = item.metadataType || item.type || null;
    const metadataName = item.metadataName || item.name || null;
    const rawChoice = item.choice || item.action || item.selection || null;

    if (!metadataType || !metadataName || !rawChoice) {
        return null;
    }

    const choice = String(rawChoice).toUpperCase();

    if (!ALLOWED_CHOICES.has(choice)) {
        return null;
    }

    const normalized = {
        metadataType: String(metadataType),
        metadataName: String(metadataName),
        choice
    };

    // TEMPORARY DIAGNOSTIC — metadataType assigned here from request fields only.
    logDeploymentSelectionDiagnostic({
        event: 'DEPLOYMENT SELECTION CREATED',
        caller: 'normalizeSelectionItem',
        file: 'deploymentSelections.foundation.js',
        method: 'normalizeSelectionItem',
        selections: [normalized],
        lastAddedEntry: {
            sourceMetadataType: item.metadataType ?? null,
            sourceType: item.type ?? null,
            assignedMetadataType: normalized.metadataType,
            assignedMetadataName: normalized.metadataName,
            choice: normalized.choice,
            rawItem: item
        }
    });

    return normalized;
}

/**
 * Normalize an optional deploymentSelections array.
 * Always returns an array; never throws on bad input.
 *
 * @param {unknown} selections
 * @returns {Array<{ metadataType: string, metadataName: string, choice: 'DEPLOY'|'SKIP' }>}
 */
function normalizeDeploymentSelections(selections) {
    if (!Array.isArray(selections) || selections.length === 0) {
        return [];
    }

    const byKey = new Map();

    for (const item of selections) {
        const normalized = normalizeSelectionItem(item);

        if (!normalized) {
            continue;
        }

        const key = `${normalized.metadataType}:${normalized.metadataName}`;

        if (!byKey.has(key)) {
            byKey.set(key, normalized);

            // TEMPORARY DIAGNOSTIC — each unique selection appended to map.
            logDeploymentSelectionDiagnostic({
                event: 'DEPLOYMENT SELECTION APPENDED',
                caller: 'normalizeDeploymentSelections',
                file: 'deploymentSelections.foundation.js',
                method: 'normalizeDeploymentSelections',
                selections: [...byKey.values()],
                lastAddedEntry: normalized
            });
        }
    }

    const result = [...byKey.values()].sort((a, b) => {
        const typeCompare = a.metadataType.localeCompare(b.metadataType);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.metadataName.localeCompare(b.metadataName);
    });

    // TEMPORARY DIAGNOSTIC — final normalized collection after merge/dedupe.
    logDeploymentSelectionDiagnostic({
        event: 'DEPLOYMENT SELECTION MERGED',
        caller: 'normalizeDeploymentSelections',
        file: 'deploymentSelections.foundation.js',
        method: 'normalizeDeploymentSelections',
        selections: result,
        lastAddedEntry: result.length ? result[result.length - 1] : null
    });

    return result;
}

/**
 * Read reserved selections from a deployment package (or equivalent object).
 * Supported locations (first match wins conceptually via attach helper):
 * - deploymentPackage.deploymentSelections
 *
 * @param {object|null|undefined} deploymentPackage
 * @returns {Array<{ metadataType: string, metadataName: string, choice: 'DEPLOY'|'SKIP' }>}
 */
function extractDeploymentSelections(deploymentPackage) {
    if (!deploymentPackage || typeof deploymentPackage !== 'object') {
        return [];
    }

    const selections = normalizeDeploymentSelections(
        deploymentPackage.deploymentSelections
    );

    // TEMPORARY DIAGNOSTIC — package-path extract.
    logDeploymentSelectionDiagnostic({
        event: 'DEPLOYMENT SELECTION EXTRACTED',
        caller: 'extractDeploymentSelections',
        file: 'deploymentSelections.foundation.js',
        method: 'extractDeploymentSelections',
        selections,
        lastAddedEntry: selections.length
            ? selections[selections.length - 1]
            : null
    });

    return selections;
}

/**
 * Attach optional top-level request selections onto the deployment package
 * for internal storage only.
 *
 * When neither top-level nor package selections are present, returns the
 * original package reference unchanged.
 *
 * @param {object|null|undefined} deploymentPackage
 * @param {unknown} topLevelSelections
 * @returns {object|null|undefined}
 */
function attachReservedDeploymentSelections(
    deploymentPackage,
    topLevelSelections
) {
    if (!deploymentPackage || typeof deploymentPackage !== 'object') {
        return deploymentPackage;
    }

    const fromTopLevel = normalizeDeploymentSelections(topLevelSelections);
    const fromPackage = extractDeploymentSelections(deploymentPackage);
    const selections =
        fromTopLevel.length > 0 ? fromTopLevel : fromPackage;

    // TEMPORARY DIAGNOSTIC — merge of top-level vs package selections.
    logDeploymentSelectionDiagnostic({
        event: 'DEPLOYMENT SELECTION MERGED',
        caller: 'attachReservedDeploymentSelections',
        file: 'deploymentSelections.foundation.js',
        method: 'attachReservedDeploymentSelections',
        selections,
        lastAddedEntry: {
            source:
                fromTopLevel.length > 0
                    ? 'req.body.deploymentSelections (top-level)'
                    : 'deploymentPackage.deploymentSelections',
            topLevelCount: fromTopLevel.length,
            packageCount: fromPackage.length,
            chosenCount: selections.length,
            entries: selections
        }
    });

    if (selections.length === 0) {
        return deploymentPackage;
    }

    return {
        ...deploymentPackage,
        deploymentSelections: selections
    };
}

module.exports = {
    normalizeDeploymentSelections,
    extractDeploymentSelections,
    attachReservedDeploymentSelections
};
