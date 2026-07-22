/**
 * Planner Compatibility Analyzer — Phase 2C (report-only).
 *
 * Completely isolated from deploymentCompatibility, Package Generation,
 * Workspace, CLI, and Deployment Planner decision mutation.
 *
 * Responsibilities:
 * - Deterministic and pure (no I/O, no HTTP, no filesystem, no Git).
 * - Uses only selectedMetadata + resolvedDependencies already in memory.
 * - Does NOT modify any input collections.
 * - Reports analysisLevel based on destination existence analysis.
 * - Does NOT encode planner fallback / editable rules.
 * - Does NOT grant canSkip (remains false until a later phase).
 *
 * Phase 2C:
 * - existsInDestination === true → analysisLevel EXISTENCE
 * - otherwise → analysisLevel NONE
 *
 * Planner continues to ignore this report while TRUSTED_ANALYSIS_LEVELS
 * remains empty.
 */

const ANALYSIS_LEVEL = Object.freeze({
    NONE: 'NONE',
    EXISTENCE: 'EXISTENCE',
    GRAPH: 'GRAPH',
    CONTRACT: 'CONTRACT',
    SEMANTIC: 'SEMANTIC'
});

function getMetadataType(item) {
    return item?.metadataType || item?.type || null;
}

function getMetadataName(item) {
    return item?.metadataName || item?.name || null;
}

function buildKey(metadataType, metadataName) {
    return `${metadataType}:${metadataName}`;
}

function resolveExistsInDestination(destinationState) {
    if (destinationState === 'EXISTS') {
        return true;
    }

    if (destinationState === 'MISSING') {
        return false;
    }

    return null;
}

/**
 * Build a planner compatibility row using destination existence analysis.
 * canSkip is intentionally unchanged (always false in Phase 2C).
 */
function buildCompatibilityResult(item) {
    const metadataType = getMetadataType(item);
    const metadataName = getMetadataName(item);
    const destinationState = item?.destinationState || null;
    const existsInDestination = resolveExistsInDestination(destinationState);

    const exists = existsInDestination === true;

    return {
        metadataType,
        metadataName,
        existsInDestination,
        graphSafe: false,
        canSkip: false,
        analysisLevel: exists
            ? ANALYSIS_LEVEL.EXISTENCE
            : ANALYSIS_LEVEL.NONE,
        reason: exists
            ? 'Destination metadata located.'
            : 'Metadata not found in destination.'
    };
}

function collectInventory(selectedMetadata, resolvedDependencies) {
    const inventory = new Map();

    function addItem(item) {
        const metadataType = getMetadataType(item);
        const metadataName = getMetadataName(item);

        if (!metadataType || !metadataName) {
            return;
        }

        const key = buildKey(metadataType, metadataName);
        const existing = inventory.get(key);

        // Prefer resolved dependency decisions when both collections contain
        // the same component (they carry destinationState / action).
        if (!existing || item?.destinationState || item?.action) {
            inventory.set(key, {
                ...(existing || {}),
                ...item,
                metadataType,
                metadataName
            });
        }
    }

    for (const item of selectedMetadata || []) {
        addItem(item);
    }

    for (const item of resolvedDependencies || []) {
        addItem(item);
    }

    return [...inventory.values()].sort((a, b) => {
        const typeCompare = String(a.metadataType).localeCompare(
            String(b.metadataType)
        );

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return String(a.metadataName).localeCompare(String(b.metadataName));
    });
}

function buildSummary(results) {
    let canSkip = 0;
    let cannotSkip = 0;
    let unknown = 0;

    for (const result of results) {
        if (result.canSkip === true) {
            canSkip += 1;
        } else if (
            result.existsInDestination === false ||
            result.graphSafe === false
        ) {
            cannotSkip += 1;
        } else {
            unknown += 1;
        }
    }

    return {
        analyzed: results.length,
        canSkip,
        cannotSkip,
        unknown
    };
}

/**
 * Analyze planner compatibility (read-only report).
 *
 * @param {object} params
 * @param {Array<object>} [params.selectedMetadata]
 * @param {Array<object>} [params.resolvedDependencies]
 * @returns {{ plannerCompatibility: { results: Array<object>, summary: object } }}
 */
function analyzePlannerCompatibility({
    selectedMetadata = [],
    resolvedDependencies = []
} = {}) {
    const inventory = collectInventory(
        Array.isArray(selectedMetadata) ? selectedMetadata : [],
        Array.isArray(resolvedDependencies) ? resolvedDependencies : []
    );

    const results = inventory.map((item) => buildCompatibilityResult(item));

    return {
        plannerCompatibility: {
            results,
            summary: buildSummary(results)
        }
    };
}

module.exports = {
    ANALYSIS_LEVEL,
    analyzePlannerCompatibility
};
