'use strict';

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    mergeBaseSha,
    showBlobAtRef,
    threeWayMergeText,
    hasConflictMarkers
} = require('./apexMergeGit.service');
const {
    defaultClassPath,
    companionMetaPath
} = require('./apexMergePaths.util');

async function mergeSingleFile({
    repoPath,
    mergeBase,
    sourceRef,
    destinationRef,
    relativePath,
    required = true
} = {}) {
    const [baseBlob, sourceBlob, destinationBlob] = await Promise.all([
        showBlobAtRef(repoPath, mergeBase, relativePath),
        showBlobAtRef(repoPath, sourceRef, relativePath),
        showBlobAtRef(repoPath, destinationRef, relativePath)
    ]);

    if (!sourceBlob.exists && required) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_SOURCE_FILE,
            `Source file is missing: ${relativePath}`
        );
    }

    if (!destinationBlob.exists && required) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_TARGET_FILE,
            `Destination file is missing: ${relativePath}`
        );
    }

    const base = baseBlob.exists ? baseBlob.content : '';
    const source = sourceBlob.exists ? sourceBlob.content : '';
    const destination = destinationBlob.exists ? destinationBlob.content : '';

    if (!sourceBlob.exists && destinationBlob.exists) {
        return {
            content: destination,
            conflict: false,
            mergeKind: 'DESTINATION_ONLY'
        };
    }

    if (sourceBlob.exists && !destinationBlob.exists) {
        return {
            content: source,
            conflict: false,
            mergeKind: 'SOURCE_ADD'
        };
    }

    const merged = await threeWayMergeText({
        current: destination,
        base,
        other: source
    });

    if (hasConflictMarkers(merged.content)) {
        return {
            content: merged.content,
            conflict: true,
            mergeKind: 'THREE_WAY'
        };
    }

    return {
        content: merged.content,
        conflict: merged.conflict === true,
        mergeKind: 'THREE_WAY'
    };
}

/**
 * Full-class three-way merge for .cls and companion -meta.xml.
 */
async function mergeApexClassFull({
    repoPath,
    sourceBranch,
    destinationBranch,
    metadataName,
    filePath = null
} = {}) {
    const clsPath = filePath || defaultClassPath(metadataName);
    const metaPath = companionMetaPath(clsPath);
    const sourceRef = `origin/${String(sourceBranch).replace(/^origin\//, '')}`;
    const destinationRef = `origin/${String(destinationBranch).replace(/^origin\//, '')}`;

    const mergeBase = await mergeBaseSha(
        repoPath,
        sourceBranch,
        destinationBranch
    );

    const clsMerge = await mergeSingleFile({
        repoPath,
        mergeBase,
        sourceRef,
        destinationRef,
        relativePath: clsPath,
        required: true
    });

    const metaMerge = await mergeSingleFile({
        repoPath,
        mergeBase,
        sourceRef,
        destinationRef,
        relativePath: metaPath,
        required: false
    });

    if (!metaMerge.content && clsMerge.mergeKind !== 'SOURCE_ADD') {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_REQUIRED_ARTIFACT,
            `Companion metadata is missing for ${metadataName}.`,
            { metadataName, metaPath }
        );
    }

    const conflictState =
        clsMerge.conflict || metaMerge.conflict
            ? 'UNRESOLVED'
            : 'NONE';

    return {
        metadataName,
        filePath: clsPath,
        metaXmlPath: metaPath,
        mergeMode: 'FULL',
        mergeBaseSha: mergeBase,
        conflictState,
        artifacts: {
            cls: {
                content: clsMerge.content,
                conflict: clsMerge.conflict === true
            },
            metaXml: {
                content: metaMerge.content || '',
                conflict: metaMerge.conflict === true
            }
        }
    };
}

function applyResolvedArtifacts(unit, resolutions = {}) {
    const clsContent =
        resolutions.cls !== undefined
            ? resolutions.cls
            : unit.artifacts.cls.content;
    const metaContent =
        resolutions.metaXml !== undefined
            ? resolutions.metaXml
            : unit.artifacts.metaXml.content;

    if (hasConflictMarkers(clsContent) || hasConflictMarkers(metaContent)) {
        throw new ApexMergeError(
            MERGE_ERROR.CONFLICT_MARKERS,
            'Resolved content still contains conflict markers.'
        );
    }

    return {
        ...unit,
        conflictState: 'RESOLVED',
        artifacts: {
            cls: { content: clsContent, conflict: false },
            metaXml: { content: metaContent, conflict: false }
        }
    };
}

module.exports = {
    mergeApexClassFull,
    mergeSingleFile,
    applyResolvedArtifacts,
    hasConflictMarkers
};
