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

    return {
        metadataType: String(metadataType),
        metadataName: String(metadataName),
        choice
    };
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
        }
    }

    return [...byKey.values()].sort((a, b) => {
        const typeCompare = a.metadataType.localeCompare(b.metadataType);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.metadataName.localeCompare(b.metadataName);
    });
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

    return normalizeDeploymentSelections(
        deploymentPackage.deploymentSelections
    );
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
