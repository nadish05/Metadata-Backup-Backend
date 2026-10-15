'use strict';

const {
    FLOW_META_SUFFIX,
    parseVersionQualifiedFlowMember
} = require('../flowMetadata/flowMemberIdentity.service');
const {
    findFlowDefinition,
    countExactFlowVersionRows
} = require('../retrieval/flowVersionDiscovery.service');
const { persistVersionArtifact } = require('../retrieval/flowVersionRetrieval.service');

const TOOLING_BOUND_UNVERSIONED_LATEST = 'tooling_bound_unversioned_latest';

const ACCEPTABLE_EXACT_VERSION_RECOVERY_CORRELATIONS = new Set([
    'versioned_filename',
    TOOLING_BOUND_UNVERSIONED_LATEST
]);

function normalizeRetrieveRelativePath(relativePath) {
    return String(relativePath || '').replace(/\\/g, '/');
}

function isFlowsFlowMetaRelativePath(relativePath) {
    const normalized = normalizeRetrieveRelativePath(relativePath);

    return (
        normalized.includes('/flows/') &&
        normalized.endsWith(FLOW_META_SUFFIX)
    );
}

function flowMetaBasenameFromRelativePath(relativePath) {
    const normalized = normalizeRetrieveRelativePath(relativePath);

    return normalized.split('/').pop() || '';
}

function validateToolingBoundUnversionedLatestIdentity({
    discovery,
    parsed,
    exactVersion
} = {}) {
    if (!discovery || !parsed?.isVersionQualified) {
        return { ok: false, reason: 'INVALID_INPUT' };
    }

    const definition = findFlowDefinition(
        discovery.definitions,
        parsed.definitionDeveloperName
    );

    if (!definition?.latestVersionId) {
        return { ok: false, reason: 'MISSING_DEFINITION_LATEST_VERSION_ID' };
    }

    const exactRows = countExactFlowVersionRows(
        discovery.versions,
        parsed.definitionDeveloperName,
        parsed.sourceVersionNumber
    );

    if (exactRows.length === 0) {
        return { ok: false, reason: 'DESTINATION_FLOW_VERSION_NOT_FOUND' };
    }

    if (exactRows.length > 1) {
        return { ok: false, reason: 'AMBIGUOUS_DESTINATION_FLOW_VERSION' };
    }

    const exactRow = exactRows[0];

    if (exactVersion && exactRow.sourceFlowVersionId !== exactVersion.sourceFlowVersionId) {
        return { ok: false, reason: 'EXACT_VERSION_DESCRIPTOR_MISMATCH' };
    }

    if (exactRow.sourceFlowVersionId !== definition.latestVersionId) {
        return { ok: false, reason: 'FLOW_ID_NOT_DEFINITION_LATEST_VERSION_ID' };
    }

    if (
        Number(exactRow.sourceFlowVersionNumber) !==
        Number(parsed.sourceVersionNumber)
    ) {
        return { ok: false, reason: 'VERSION_NUMBER_MISMATCH' };
    }

    if (
        definition.latestVersionNumber != null &&
        Number(definition.latestVersionNumber) !==
            Number(parsed.sourceVersionNumber)
    ) {
        return { ok: false, reason: 'REQUESTED_VERSION_NOT_LATEST' };
    }

    if (
        exactRow.flowIsActiveVersion === true ||
        exactRow.flowVersionStatus === 'Active'
    ) {
        return { ok: false, reason: 'DESTINATION_FLOW_VERSION_ACTIVE' };
    }

    return {
        ok: true,
        exactRow,
        definition
    };
}

function analyzeWorkspaceFlowArtifactsForToolingBoundRecovery(
    retrievedFiles,
    definitionDeveloperName
) {
    const flowMetaFiles = (retrievedFiles || []).filter((file) =>
        isFlowsFlowMetaRelativePath(file.relativePath)
    );
    const unversionedBasename = `${definitionDeveloperName}${FLOW_META_SUFFIX}`;
    const unversionedMatches = [];
    const versionQualifiedMatches = [];
    const unrelatedMatches = [];

    for (const file of flowMetaFiles) {
        const basename = flowMetaBasenameFromRelativePath(file.relativePath);
        const stem = basename.slice(0, -FLOW_META_SUFFIX.length);
        const stemParsed = parseVersionQualifiedFlowMember(stem);

        if (!stemParsed) {
            unrelatedMatches.push(file);
            continue;
        }

        if (
            !stemParsed.isVersionQualified &&
            stemParsed.definitionDeveloperName === definitionDeveloperName
        ) {
            if (basename === unversionedBasename) {
                unversionedMatches.push(file);
            } else {
                unrelatedMatches.push(file);
            }
            continue;
        }

        if (
            stemParsed.isVersionQualified &&
            stemParsed.definitionDeveloperName === definitionDeveloperName
        ) {
            versionQualifiedMatches.push(file);
            continue;
        }

        unrelatedMatches.push(file);
    }

    if (unrelatedMatches.length > 0) {
        return { ok: false, reason: 'AMBIGUOUS_WORKSPACE_FLOW_FILES' };
    }

    if (versionQualifiedMatches.length > 0) {
        return { ok: false, reason: 'CONFLICTING_VERSION_QUALIFIED_FILES' };
    }

    if (unversionedMatches.length !== 1) {
        return { ok: false, reason: 'UNVERSIONED_FILE_NOT_UNIQUE' };
    }

    return {
        ok: true,
        unversionedFile: unversionedMatches[0]
    };
}

async function attemptToolingBoundUnversionedLatestRecovery({
    workspacePath,
    metadataName,
    parsed,
    discovery,
    exactVersion,
    retrievedFiles
} = {}) {
    const identity = validateToolingBoundUnversionedLatestIdentity({
        discovery,
        parsed,
        exactVersion
    });

    if (!identity.ok) {
        return identity;
    }

    const workspace = analyzeWorkspaceFlowArtifactsForToolingBoundRecovery(
        retrievedFiles,
        parsed.definitionDeveloperName
    );

    if (!workspace.ok) {
        return workspace;
    }

    const sourceBytes = workspace.unversionedFile.bytes;

    if (!sourceBytes || !sourceBytes.length) {
        return { ok: false, reason: 'UNVERSIONED_FILE_EMPTY' };
    }

    const persisted = await persistVersionArtifact({
        projectPath: workspacePath,
        developerName: parsed.definitionDeveloperName,
        versionNumber: parsed.sourceVersionNumber,
        sourceBytes
    });

    return {
        ok: true,
        retrieved: {
            ...exactVersion,
            requestedMetadataMember: `Flow:${metadataName}`,
            retrievedArtifactPath: normalizeRetrieveRelativePath(
                workspace.unversionedFile.relativePath
            ),
            retrievedArtifactCorrelation: TOOLING_BOUND_UNVERSIONED_LATEST,
            workspaceArtifactPath: persisted.workspaceArtifactPath,
            artifactSha256: persisted.artifactSha256
        }
    };
}

module.exports = {
    TOOLING_BOUND_UNVERSIONED_LATEST,
    ACCEPTABLE_EXACT_VERSION_RECOVERY_CORRELATIONS,
    validateToolingBoundUnversionedLatestIdentity,
    analyzeWorkspaceFlowArtifactsForToolingBoundRecovery,
    attemptToolingBoundUnversionedLatestRecovery
};
