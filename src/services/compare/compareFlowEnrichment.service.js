'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    parseFlowArtifactBasename,
    buildFlowSelectionIdentity,
    enrichFlowMetadataItem
} = require('../flowMetadata/flowMemberIdentity.service');

const FLOW_VERSION_MANIFEST = path.join(
    '.metadata-backup',
    'flow-version-artifacts.json'
);

function hashUtf8(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function loadFlowVersionManifest(repoPath) {
    const manifestPath = path.join(repoPath, FLOW_VERSION_MANIFEST);

    try {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(raw);

        return Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
    } catch (error) {
        return [];
    }
}

function findManifestArtifact(manifestArtifacts, filePath) {
    const parsed = parseFlowArtifactBasename(filePath);

    if (!parsed) {
        return null;
    }

    return (
        manifestArtifacts.find(
            (artifact) =>
                artifact.workspaceArtifactPath === parsed.workspaceArtifactPath ||
                artifact.workspaceArtifactPath === filePath.replace(/\\/g, '/')
        ) || null
    );
}

function enrichCompareFlowFileEntry({
    filePath,
    changeType,
    flowStatus,
    fileContent = null,
    manifestArtifacts = []
}) {
    const base = {
        filePath,
        changeType,
        flowStatus
    };

    const parsed = parseFlowArtifactBasename(filePath);

    if (!parsed) {
        return base;
    }

    const manifestArtifact = findManifestArtifact(manifestArtifacts, filePath);
    const metadataName =
        parsed.isVersionQualified && parsed.sourceVersionNumber != null
            ? `${parsed.definitionDeveloperName}-${parsed.sourceVersionNumber}`
            : parsed.definitionDeveloperName;

    const enriched = enrichFlowMetadataItem({
        metadataType: 'Flow',
        metadataName,
        filePath: parsed.workspaceArtifactPath,
        sourceFlowVersionId: manifestArtifact?.sourceFlowVersionId || null,
        flowVersionStatus:
            manifestArtifact?.flowVersionStatus || flowStatus || null,
        flowIsActiveVersion: manifestArtifact?.flowIsActiveVersion,
        flowIsLatestVersion: manifestArtifact?.flowIsLatestVersion,
        artifactSha256:
            manifestArtifact?.artifactSha256 ||
            (fileContent ? hashUtf8(fileContent) : null)
    });

    return {
        ...base,
        metadataType: 'Flow',
        flowDefinitionDeveloperName: enriched.flowDefinitionDeveloperName,
        sourceFlowVersionNumber: enriched.sourceFlowVersionNumber,
        sourceFlowVersionId: enriched.sourceFlowVersionId || null,
        selectedMetadataMemberName: enriched.selectedMetadataMemberName,
        workspaceArtifactPath: enriched.filePath,
        artifactSha256: enriched.artifactSha256 || null,
        flowVersionStatus: enriched.flowVersionStatus || null,
        flowIsActiveVersion:
            enriched.flowIsActiveVersion === true ||
            enriched.flowIsActiveVersion === false
                ? enriched.flowIsActiveVersion
                : null,
        flowIsLatestVersion:
            enriched.flowIsLatestVersion === true ||
            enriched.flowIsLatestVersion === false
                ? enriched.flowIsLatestVersion
                : null,
        selectionIdentity: buildFlowSelectionIdentity('Flow', metadataName)
    };
}

module.exports = {
    enrichCompareFlowFileEntry,
    loadFlowVersionManifest,
    hashUtf8
};
