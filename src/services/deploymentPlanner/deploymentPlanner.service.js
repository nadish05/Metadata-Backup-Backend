/**
 * Deployment Planner service (Phase 4.4B).
 *
 * Applies user Deploy/Skip preferences onto the dependency decision model.
 *
 * Rules:
 * - Selections are preferences, not deployment instructions.
 * - Match by metadataType + metadataName.
 * - Only override when editable === true.
 * - Only mutate selected (true for DEPLOY, false for SKIP).
 * - Never mutate action, required, destinationState, or other fields.
 * - Unknown / non-editable / unmatched selections are ignored.
 *
 * Package Generation must continue reading the decision model only.
 */

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function decisionKey(metadataType, metadataName) {
    return `${metadataType}:${metadataName}`;
}

function getDecisionType(decision) {
    return decision?.metadataType || decision?.type || null;
}

function getDecisionName(decision) {
    return decision?.name || decision?.metadataName || null;
}

function buildDecisionIndex(resolvedDependencies) {
    const index = new Map();

    for (let i = 0; i < resolvedDependencies.length; i += 1) {
        const decision = resolvedDependencies[i];
        const metadataType = getDecisionType(decision);
        const metadataName = getDecisionName(decision);

        if (!metadataType || !metadataName) {
            continue;
        }

        const key = decisionKey(metadataType, metadataName);

        if (!index.has(key)) {
            index.set(key, i);
        }
    }

    return index;
}

/**
 * Apply Deployment Planner selections to resolved dependency decisions.
 *
 * @param {Array<object>} resolvedDependencies
 * @param {Array<{ metadataType: string, metadataName: string, choice: 'DEPLOY'|'SKIP' }>} deploymentSelections
 * @returns {{
 *   resolvedDependencies: Array<object>,
 *   summary: {
 *     selectionsReceived: number,
 *     overridesApplied: number,
 *     overridesIgnored: number,
 *     mandatoryIgnored: number,
 *     unknownIgnored: number
 *   }
 * }}
 */
function applyPlannerOverrides(
    resolvedDependencies,
    deploymentSelections = []
) {
    const dependencies = Array.isArray(resolvedDependencies)
        ? resolvedDependencies
        : [];
    const selections = Array.isArray(deploymentSelections)
        ? deploymentSelections
        : [];

    const summary = {
        selectionsReceived: selections.length,
        overridesApplied: 0,
        overridesIgnored: 0,
        mandatoryIgnored: 0,
        unknownIgnored: 0
    };

    if (selections.length === 0) {
        return {
            resolvedDependencies: dependencies,
            summary
        };
    }

    logSection('Deployment Planner');
    console.log('Planner selections received:', summary.selectionsReceived);

    const indexed = dependencies.map((decision) => ({ ...decision }));
    const decisionIndex = buildDecisionIndex(indexed);

    for (const selection of selections) {
        const metadataType = selection?.metadataType || null;
        const metadataName = selection?.metadataName || null;
        const choice = selection?.choice || null;

        if (!metadataType || !metadataName || !choice) {
            summary.overridesIgnored += 1;
            continue;
        }

        const key = decisionKey(metadataType, metadataName);
        const index = decisionIndex.get(key);

        if (index === undefined) {
            summary.unknownIgnored += 1;
            summary.overridesIgnored += 1;
            console.log(
                'Overrides ignored (unknown):',
                `${metadataType}:${metadataName}`
            );
            continue;
        }

        const decision = indexed[index];

        if (decision.editable !== true) {
            summary.mandatoryIgnored += 1;
            summary.overridesIgnored += 1;
            console.log(
                'Mandatory metadata ignored:',
                `${metadataType}:${metadataName}`
            );
            continue;
        }

        const nextSelected = choice === 'DEPLOY';

        if (decision.selected === nextSelected) {
            // Preference already matches; no effective override.
            continue;
        }

        indexed[index] = {
            ...decision,
            selected: nextSelected
        };

        summary.overridesApplied += 1;
        console.log(
            'Overrides applied:',
            `${metadataType}:${metadataName}`,
            '→',
            choice
        );
    }

    console.log('Overrides applied:', summary.overridesApplied);
    console.log('Overrides ignored:', summary.overridesIgnored);
    console.log('Mandatory metadata ignored:', summary.mandatoryIgnored);

    return {
        resolvedDependencies: indexed,
        summary
    };
}

module.exports = {
    applyPlannerOverrides
};
