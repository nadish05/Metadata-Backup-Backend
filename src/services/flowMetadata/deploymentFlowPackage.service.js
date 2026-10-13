'use strict';

const {
    parseVersionQualifiedFlowMember
} = require('./flowMemberIdentity.service');

const FLOW_MULTIPLE_VERSIONS_CODE = 'FLOW_MULTIPLE_VERSIONS_SAME_DEFINITION';

function collectFlowSelections(metadataItems) {
    const flows = [];

    if (!Array.isArray(metadataItems)) {
        return flows;
    }

    for (const item of metadataItems) {
        if (item?.metadataType !== 'Flow') {
            continue;
        }

        const metadataName = item.metadataName || item.selectedMetadataMemberName;

        if (!metadataName) {
            continue;
        }

        flows.push({
            item,
            metadataName,
            parsed: parseVersionQualifiedFlowMember(metadataName)
        });
    }

    return flows;
}

function validateFlowDeploymentSelections(selectedMetadata) {
    const flows = collectFlowSelections(selectedMetadata);
    const byDefinition = new Map();

    for (const flow of flows) {
        const definitionName = flow.parsed?.definitionDeveloperName;

        if (!definitionName) {
            continue;
        }

        if (!byDefinition.has(definitionName)) {
            byDefinition.set(definitionName, []);
        }

        byDefinition.get(definitionName).push(flow);
    }

    const conflicts = [];

    for (const [definitionName, entries] of byDefinition.entries()) {
        if (entries.length <= 1) {
            continue;
        }

        conflicts.push({
            flowDefinitionDeveloperName: definitionName,
            selectedMetadataMemberNames: entries.map((entry) => entry.metadataName)
        });
    }

    if (!conflicts.length) {
        return { ok: true, conflicts: [] };
    }

    return {
        ok: false,
        code: FLOW_MULTIPLE_VERSIONS_CODE,
        message:
            'Multiple Flow versions of the same definition cannot be deployed in a single package. ' +
            'Select one version per flow definition per deployment.',
        conflicts
    };
}

module.exports = {
    FLOW_MULTIPLE_VERSIONS_CODE,
    collectFlowSelections,
    validateFlowDeploymentSelections
};
