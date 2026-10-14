'use strict';

const { parseVersionQualifiedFlowMember } = require('../flowMetadata/flowMemberIdentity.service');
const {
    discoverFlowVersions
} = require('../retrieval/flowVersionDiscovery.service');

const FLOW_DESTINATION_CAPTURE_OUTCOME = Object.freeze({
    UNVERSIONED: 'UNVERSIONED',
    DEFINITION_ABSENT: 'DEFINITION_ABSENT',
    VERSION_PRESENT: 'VERSION_PRESENT',
    VERSION_ABSENT_DEFINITION_PRESENT: 'VERSION_ABSENT_DEFINITION_PRESENT',
    TOOLING_FAILED: 'TOOLING_FAILED'
});

function findDefinition(definitions, definitionDeveloperName) {
    if (!Array.isArray(definitions)) {
        return null;
    }

    return definitions.find(
        (row) => row.developerName === definitionDeveloperName
    );
}

function findExactVersion(versions, definitionDeveloperName, versionNumber) {
    if (!Array.isArray(versions)) {
        return null;
    }

    const requested = Number(versionNumber);

    return versions.find((row) => {
        if (row.flowDefinitionDeveloperName !== definitionDeveloperName) {
            return false;
        }

        const candidate = Number(row.sourceFlowVersionNumber);

        return Number.isFinite(candidate) && candidate === requested;
    });
}

/**
 * Resolve whether the exact Flow version exists on the destination org before
 * deploy capture. Does not retrieve metadata.
 */
async function resolveFlowDestinationVersionForCapture({
    metadataName,
    instanceUrl,
    accessToken,
    discoverFlowVersionsFn = discoverFlowVersions
} = {}) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed?.isVersionQualified) {
        return { outcome: FLOW_DESTINATION_CAPTURE_OUTCOME.UNVERSIONED };
    }

    const definitionDeveloperName = parsed.definitionDeveloperName;
    const requestedVersion = parsed.sourceVersionNumber;

    let discovery;

    try {
        discovery = await discoverFlowVersionsFn({
            instanceUrl,
            accessToken
        });
    } catch (error) {
        return {
            outcome: FLOW_DESTINATION_CAPTURE_OUTCOME.TOOLING_FAILED,
            detail: error.message || 'Flow version discovery failed.'
        };
    }

    const definition = findDefinition(
        discovery.definitions,
        definitionDeveloperName
    );
    const exactVersion = findExactVersion(
        discovery.versions,
        definitionDeveloperName,
        requestedVersion
    );

    if (exactVersion) {
        return {
            outcome: FLOW_DESTINATION_CAPTURE_OUTCOME.VERSION_PRESENT,
            definitionDeveloperName,
            requestedVersion,
            versionDescriptor: exactVersion
        };
    }

    if (!definition) {
        return {
            outcome: FLOW_DESTINATION_CAPTURE_OUTCOME.DEFINITION_ABSENT,
            definitionDeveloperName,
            requestedVersion
        };
    }

    return {
        outcome:
            FLOW_DESTINATION_CAPTURE_OUTCOME.VERSION_ABSENT_DEFINITION_PRESENT,
        definitionDeveloperName,
        requestedVersion,
        definitionSummary: definition
    };
}

module.exports = {
    FLOW_DESTINATION_CAPTURE_OUTCOME,
    resolveFlowDestinationVersionForCapture,
    findDefinition,
    findExactVersion
};
