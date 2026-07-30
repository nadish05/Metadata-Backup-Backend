const {
    createPassFinding,
    createFinding,
    SEVERITY,
    STATUS
} = require('../compatibilityModel');
const {
    classifyDependency
} = require('../../dependencyResolution/dependencyClassification.service');

const RULE_ID = 'artifact.exists';

function getNodeKey(item) {
    const metadataType = item?.metadataType || item?.type;
    const name = item?.metadataName || item?.name;

    if (!metadataType || !name) {
        return null;
    }

    return `${metadataType}:${name}`;
}

function resolveArtifactRequired(item) {
    if (typeof item?.artifactRequired === 'boolean') {
        return item.artifactRequired;
    }

    return classifyDependency(item).artifactRequired === true;
}

function collectArtifactRequiredCandidates(context) {
    const candidates = [];
    const seen = new Set();

    function add(item) {
        const metadataType = item?.metadataType || item?.type;
        const name = item?.metadataName || item?.name;
        const key = getNodeKey(item);

        if (!metadataType || !name || !key || seen.has(key)) {
            return;
        }

        if (!resolveArtifactRequired(item)) {
            return;
        }

        seen.add(key);
        candidates.push({
            metadataType,
            metadataName: name,
            name,
            sourceExists: item.sourceExists,
            artifactResolved: item.artifactResolved,
            filePath: item.filePath || null,
            action: item.action || null,
            selected: item.selected,
            deployable: item.deployable,
            artifactRequired: true,
            classification: item.classification || null
        });
    }

    // User-selected metadata is always intended for packaging.
    for (const item of context.selectedMetadata || []) {
        add(item);
    }

    // Resolved dependencies: artifactRequired replaces action==DEPLOY as the gate.
    // Still require an active deploy decision so REFERENCE-only targets are not
    // blocked when the object exists only in the destination org.
    for (const item of context.resolvedDependencies || []) {
        if (
            resolveArtifactRequired(item) &&
            item.action === 'DEPLOY' &&
            item.selected !== false
        ) {
            add(item);
        }
    }

    for (const item of context.discoveredReferences || []) {
        if (
            resolveArtifactRequired(item) &&
            item.deployable === true &&
            item.blocking === true
        ) {
            add(item);
        }
    }

    return candidates;
}

/**
 * Verify artifact-required metadata has a resolvable source artifact in the repo.
 * Platform / runtime / unknown classifications are excluded via artifactRequired.
 */
const artifactExistsRule = {
    id: RULE_ID,
    metadataTypes: ['*'],

    applies(context) {
        return collectArtifactRequiredCandidates(context).some(
            (item) =>
                item.artifactResolved === false ||
                item.sourceExists === false ||
                item.artifactResolved === true
        );
    },

    analyze(context) {
        const findings = [];
        const candidates = collectArtifactRequiredCandidates(context);

        for (const item of candidates) {
            // Only evaluate nodes that participated in artifact resolution.
            if (
                item.artifactResolved == null &&
                item.sourceExists == null
            ) {
                continue;
            }

            if (item.artifactResolved === true && item.sourceExists === true) {
                findings.push(
                    createPassFinding({
                        metadataName: item.name,
                        metadataType: item.metadataType,
                        ruleId: RULE_ID,
                        reason:
                            'Source artifact exists in the selected source branch.'
                    })
                );
                continue;
            }

            findings.push(
                createFinding({
                    id: `${RULE_ID}:${item.metadataType}:${item.name}:FAIL`,
                    metadataName: item.name,
                    metadataType: item.metadataType,
                    ruleId: RULE_ID,
                    severity: SEVERITY.ERROR,
                    status: STATUS.FAIL,
                    reason:
                        'Source artifact does not exist inside the selected source branch.',
                    requiredBy: null,
                    recommendedAction:
                        'Add the metadata to the source branch repository or remove it from the deployment graph.',
                    blocking: true
                })
            );
        }

        return findings;
    }
};

module.exports = artifactExistsRule;
