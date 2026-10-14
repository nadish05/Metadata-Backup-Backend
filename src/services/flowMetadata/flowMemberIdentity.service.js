'use strict';

const FLOW_META_SUFFIX = '.flow-meta.xml';
const FLOWS_DIR_PREFIX = 'force-app/main/default/flows/';

/**
 * Parse Salesforce version-qualified Flow member names (e.g. My_Flow-2).
 * Does not infer version from unversioned names.
 */
function parseVersionQualifiedFlowMember(metadataName) {
    const raw = String(metadataName || '').trim();

    if (!raw) {
        return null;
    }

    const match = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(raw);

    if (!match) {
        return {
            definitionDeveloperName: raw,
            sourceVersionNumber: null,
            isVersionQualified: false,
            requestedMetadataMemberName: raw
        };
    }

    const versionNumber = Number.parseInt(match[2], 10);

    if (!Number.isFinite(versionNumber) || versionNumber < 1) {
        return null;
    }

    return {
        definitionDeveloperName: match[1],
        sourceVersionNumber: versionNumber,
        isVersionQualified: true,
        requestedMetadataMemberName: raw
    };
}

function buildFlowSelectionIdentity(metadataType, metadataName) {
    const type = String(metadataType || 'Flow').trim();
    const name = String(metadataName || '').trim();

    if (!name) {
        return null;
    }

    return `${type}:${name}`;
}

function buildCanonicalFlowArtifactRelativePath(metadataName) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed) {
        return null;
    }

    const fileBase =
        parsed.isVersionQualified && parsed.sourceVersionNumber != null
            ? `${parsed.definitionDeveloperName}-${parsed.sourceVersionNumber}`
            : parsed.definitionDeveloperName;

    return `${FLOWS_DIR_PREFIX}${fileBase}${FLOW_META_SUFFIX}`;
}

function parseFlowArtifactBasename(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    const base = normalized.split('/').pop() || '';

    if (!base.endsWith(FLOW_META_SUFFIX)) {
        return null;
    }

    const stem = base.slice(0, -FLOW_META_SUFFIX.length);
    const member = parseVersionQualifiedFlowMember(stem);

    if (!member) {
        return null;
    }

    return {
        ...member,
        workspaceArtifactPath: normalized.includes('/flows/')
            ? normalized
            : `${FLOWS_DIR_PREFIX}${base}`
    };
}

function enrichFlowMetadataItem(item) {
    if (!item || item.metadataType !== 'Flow') {
        return item;
    }

    const metadataName = item.metadataName || item.name || null;

    if (!metadataName) {
        return item;
    }

    const parsed = parseVersionQualifiedFlowMember(metadataName);
    const selectionIdentity = buildFlowSelectionIdentity('Flow', metadataName);
    const canonicalPath = buildCanonicalFlowArtifactRelativePath(metadataName);

    const enriched = {
        ...item,
        metadataType: 'Flow',
        metadataName,
        flowDefinitionDeveloperName: parsed.definitionDeveloperName,
        sourceFlowVersionNumber: parsed.sourceVersionNumber,
        selectedMetadataMemberName: parsed.requestedMetadataMemberName,
        selectionIdentity,
        isFlowVersionQualified: parsed.isVersionQualified
    };

    if (!enriched.filePath && canonicalPath) {
        enriched.filePath = canonicalPath;
    }

    if (item.sourceFlowVersionId) {
        enriched.sourceFlowVersionId = item.sourceFlowVersionId;
    }

    if (item.artifactSha256) {
        enriched.artifactSha256 = item.artifactSha256;
    }

    if (item.flowVersionStatus) {
        enriched.flowVersionStatus = item.flowVersionStatus;
    }

    if (item.flowIsActiveVersion === true || item.flowIsActiveVersion === false) {
        enriched.flowIsActiveVersion = item.flowIsActiveVersion;
    }

    if (item.flowIsLatestVersion === true || item.flowIsLatestVersion === false) {
        enriched.flowIsLatestVersion = item.flowIsLatestVersion;
    }

    return enriched;
}

/**
 * For version-qualified Flow members, normalize SNAPMEM1 pack paths to the
 * canonical versioned relative path while preserving file bytes.
 */
function applyCanonicalFlowSnapshotPackPaths(files, metadataName) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed?.isVersionQualified) {
        return files;
    }

    const canonicalPath = buildCanonicalFlowArtifactRelativePath(metadataName);

    if (!canonicalPath || !Array.isArray(files) || files.length !== 1) {
        return files;
    }

    const file = files[0];
    const relativePath = String(file.relativePath || '').replace(/\\/g, '/');

    if (
        !relativePath.includes('/flows/') ||
        !relativePath.endsWith(FLOW_META_SUFFIX)
    ) {
        return files;
    }

    return [
        {
            ...file,
            relativePath: canonicalPath
        }
    ];
}

function getFlowMetadataUniquenessKey(item) {
    if (!item || item.metadataType !== 'Flow') {
        return null;
    }

    const name = item.metadataName || item.selectedMetadataMemberName;

    if (!name) {
        return null;
    }

    return `Flow:${name}`;
}

module.exports = {
    FLOW_META_SUFFIX,
    FLOWS_DIR_PREFIX,
    parseVersionQualifiedFlowMember,
    buildFlowSelectionIdentity,
    buildCanonicalFlowArtifactRelativePath,
    parseFlowArtifactBasename,
    enrichFlowMetadataItem,
    getFlowMetadataUniquenessKey,
    applyCanonicalFlowSnapshotPackPaths
};
