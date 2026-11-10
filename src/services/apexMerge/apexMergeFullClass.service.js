'use strict';

const crypto = require('crypto');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');

function sha256Utf8(content) {
    return crypto
        .createHash('sha256')
        .update(String(content ?? ''), 'utf8')
        .digest('hex');
}

const RESOLUTION_STRATEGIES = Object.freeze({
    ACCEPT_SOURCE: 'ACCEPT_SOURCE',
    ACCEPT_TARGET: 'ACCEPT_TARGET'
});
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

    const threeWay = { base, source, destination };

    if (!sourceBlob.exists && destinationBlob.exists) {
        return {
            content: destination,
            conflict: false,
            mergeKind: 'DESTINATION_ONLY',
            threeWay
        };
    }

    if (sourceBlob.exists && !destinationBlob.exists) {
        return {
            content: source,
            conflict: false,
            mergeKind: 'SOURCE_ADD',
            threeWay
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
            mergeKind: 'THREE_WAY',
            threeWay
        };
    }

    return {
        content: merged.content,
        conflict: merged.conflict === true,
        mergeKind: 'THREE_WAY',
        threeWay
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
        threeWay: {
            cls: clsMerge.threeWay,
            metaXml: metaMerge.threeWay || {
                base: '',
                source: '',
                destination: metaMerge.content || ''
            }
        },
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

function buildConflictSummaries(unit) {
    const conflicts = [];

    if (unit.artifacts?.cls?.conflict) {
        conflicts.push({
            id: `${unit.metadataName}:cls`,
            artifact: 'cls',
            message: 'Three-way merge produced conflict markers in .cls.'
        });
    }

    if (unit.artifacts?.metaXml?.conflict) {
        conflicts.push({
            id: `${unit.metadataName}:metaXml`,
            artifact: 'metaXml',
            message: 'Three-way merge produced conflict markers in .cls-meta.xml.'
        });
    }

    return conflicts;
}

function applyStrategyResolution(unit, strategy) {
    const normalized = String(strategy || '').trim().toUpperCase();

    if (
        normalized !== RESOLUTION_STRATEGIES.ACCEPT_SOURCE &&
        normalized !== RESOLUTION_STRATEGIES.ACCEPT_TARGET
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_RESOLUTION_STRATEGY,
            'resolutionStrategy must be ACCEPT_SOURCE or ACCEPT_TARGET.',
            { strategy }
        );
    }

    const side =
        normalized === RESOLUTION_STRATEGIES.ACCEPT_SOURCE
            ? 'source'
            : 'destination';
    const threeWay = unit.threeWay;

    if (!threeWay?.cls?.[side]) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_THREE_WAY_ARTIFACTS,
            `Missing ${side} .cls artifact for ${unit.metadataName}. Preview required before resolve.`
        );
    }

    const metaSide = threeWay.metaXml?.[side];
    const metaContent =
        metaSide !== undefined && metaSide !== null
            ? metaSide
            : threeWay.metaXml?.destination ?? '';

    return applyResolvedArtifacts(unit, {
        cls: threeWay.cls[side],
        metaXml: metaContent
    });
}

function resolveUnitArtifacts(unit, resolution = {}) {
    const strategy =
        resolution.resolutionStrategy || resolution.strategy || null;
    const manual = resolution.resolutions || resolution;

    if (strategy) {
        return applyStrategyResolution(unit, strategy);
    }

    if (manual && (manual.cls !== undefined || manual.metaXml !== undefined)) {
        return applyResolvedArtifacts(unit, manual);
    }

    throw new ApexMergeError(
        MERGE_ERROR.INVALID_REQUEST,
        `Resolution for ${unit.metadataName} must include resolutionStrategy or explicit cls/metaXml content.`
    );
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
            cls: {
                content: clsContent,
                conflict: false,
                sha256: sha256Utf8(clsContent)
            },
            metaXml: {
                content: metaContent,
                conflict: false,
                sha256: sha256Utf8(metaContent)
            }
        }
    };
}

module.exports = {
    RESOLUTION_STRATEGIES,
    mergeApexClassFull,
    mergeSingleFile,
    applyResolvedArtifacts,
    applyStrategyResolution,
    resolveUnitArtifacts,
    buildConflictSummaries,
    hasConflictMarkers
};
