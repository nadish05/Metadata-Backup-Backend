'use strict';

const crypto = require('crypto');
const { mergeBaseSha } = require('./apexMergeGit.service');
const {
    mergeSingleFile,
    applyResolvedArtifacts
} = require('./apexMergeFullClass.service');
const {
    companionMetaPath
} = require('./apexMergePaths.util');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const { parseApexClassSource } = require('./apexClassParser.service');
const {
    validateComposedMethodMerge,
    rootCallableMembers
} = require('./apexMergeMethodComposer.service');
const {
    METHOD_MERGE_MODE,
    METHOD_STATUS,
    METHOD_RESOLUTION_STRATEGY,
    compareApexMethodMerge,
    applyMethodResolutions,
    composeApexMethodMerge,
    executeApexMethodMerge
} = require('./apexMergeMethodMerge.service');

function sha256Utf8(content) {
    return crypto
        .createHash('sha256')
        .update(String(content ?? ''), 'utf8')
        .digest('hex');
}

function normalizeMergeMode(mode) {
    const normalized = String(mode || 'FULL')
        .trim()
        .toUpperCase();

    if (normalized === METHOD_MERGE_MODE) {
        return METHOD_MERGE_MODE;
    }

    return 'FULL';
}

function shouldUseMethodMode(requestMode, focusMetadataName, unitMetadataName) {
    if (normalizeMergeMode(requestMode) !== METHOD_MERGE_MODE) {
        return false;
    }

    if (!focusMetadataName) {
        return true;
    }

    return focusMetadataName === unitMetadataName;
}

function implementationTextFromMap(memberMap, methodKey) {
    if (!memberMap || !memberMap.has(methodKey)) {
        return null;
    }

    const member = memberMap.get(methodKey);
    return member?.sourceText ?? null;
}

function mapMethodInventoryForClient(methods = [], implementationMaps = null) {
    const baseMap = implementationMaps?.base;
    const sourceMap = implementationMaps?.source;
    const destinationMap = implementationMaps?.destination;

    return methods.map((entry) => {
        const item = {
            methodKey: entry.methodKey,
            basePresent: entry.basePresent,
            sourcePresent: entry.sourcePresent,
            destinationPresent: entry.destinationPresent,
            status: entry.status,
            resolution: entry.resolution ?? null,
            included: entry.included !== false
        };

        if (entry.status === METHOD_STATUS.CONFLICT && implementationMaps) {
            item.baseImplementation = entry.basePresent
                ? implementationTextFromMap(baseMap, entry.methodKey)
                : null;
            item.sourceImplementation = entry.sourcePresent
                ? implementationTextFromMap(sourceMap, entry.methodKey)
                : null;
            item.destinationImplementation = entry.destinationPresent
                ? implementationTextFromMap(destinationMap, entry.methodKey)
                : null;
        }

        return item;
    });
}

function buildMethodConflictSummaries(metadataName, methodMerge) {
    if (!methodMerge?.methods?.length) {
        return [];
    }

    return methodMerge.methods
        .filter((entry) => entry.status === METHOD_STATUS.CONFLICT)
        .map((entry) => ({
            id: `${metadataName}:method:${entry.methodKey}`,
            artifact: 'method',
            methodKey: entry.methodKey,
            message: `Method ${entry.methodKey} has conflicting implementations.`
        }));
}

function buildMethodMergeState(mergeResult) {
    return {
        methods: mapMethodInventoryForClient(
            mergeResult.methods,
            mergeResult.maps
        ),
        conflictCount: mergeResult.conflictCount,
        resolved: mergeResult.resolved === true,
        composeSuccess: mergeResult.composeSuccess === true,
        methodResolutions: []
    };
}

function runMethodMergeComparison(clsThreeWay) {
    if (!clsThreeWay?.source) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_THREE_WAY_ARTIFACTS,
            'METHOD merge requires Source .cls content from preview.'
        );
    }

    return executeApexMethodMerge({
        baseContent: clsThreeWay.base ?? '',
        sourceContent: clsThreeWay.source,
        destinationContent: clsThreeWay.destination ?? ''
    });
}

function mergeStoredMethodResolutions(existingResolutions = [], incomingResolutions = []) {
    const byKey = new Map();

    for (const entry of existingResolutions || []) {
        if (entry?.methodKey) {
            byKey.set(entry.methodKey, entry);
        }
    }

    for (const entry of incomingResolutions || []) {
        if (entry?.methodKey) {
            byKey.set(entry.methodKey, entry);
        }
    }

    return [...byKey.values()];
}

function assertResolvableMethodKeys(comparisonMethods, methodResolutions) {
    const knownKeys = new Set(
        comparisonMethods.map((entry) => entry.methodKey)
    );

    for (const resolution of methodResolutions) {
        if (!knownKeys.has(resolution.methodKey)) {
            throw new ApexMergeError(
                MERGE_ERROR.UNKNOWN_METHOD_KEY,
                `Unknown methodKey: ${resolution.methodKey}.`,
                { methodKey: resolution.methodKey }
            );
        }
    }
}

function assertResolutionTargetsAreConflicts(comparisonMethods, methodResolutions) {
    const byKey = new Map(
        comparisonMethods.map((entry) => [entry.methodKey, entry])
    );

    for (const resolution of methodResolutions) {
        const item = byKey.get(resolution.methodKey);

        if (
            item.status !== METHOD_STATUS.CONFLICT &&
            item.status !== METHOD_STATUS.RESOLVED
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `Method ${resolution.methodKey} is not in conflict and cannot be resolved.`,
                { methodKey: resolution.methodKey, status: item.status }
            );
        }
    }
}

function buildMethodPreviewUnit({
    metadataName,
    filePath,
    metaXmlPath,
    mergeBaseSha,
    clsThreeWay,
    metaMerge
}) {
    const mergeResult = runMethodMergeComparison(clsThreeWay);
    const methodMerge = buildMethodMergeState(mergeResult);
    const composedCls = mergeResult.composeSuccess
        ? mergeResult.composedSource
        : null;

    return {
        metadataName,
        filePath,
        metaXmlPath,
        mergeMode: METHOD_MERGE_MODE,
        mergeBaseSha,
        conflictState:
            mergeResult.conflictCount > 0 ? 'UNRESOLVED' : 'NONE',
        drift: null,
        threeWay: {
            cls: clsThreeWay,
            metaXml:
                metaMerge?.threeWay || {
                    base: '',
                    source: '',
                    destination: metaMerge?.content || ''
                }
        },
        methodMerge,
        artifacts: {
            cls: {
                content: composedCls,
                conflict: mergeResult.conflictCount > 0,
                sha256: composedCls ? sha256Utf8(composedCls) : null
            },
            metaXml: {
                content: metaMerge?.content || '',
                conflict: metaMerge?.conflict === true,
                sha256: sha256Utf8(metaMerge?.content || '')
            }
        }
    };
}

/**
 * METHOD-mode preview using existing Git three-way cls/meta retrieval.
 */
async function previewApexClassMethod({
    repoPath,
    sourceBranch,
    destinationBranch,
    metadataName,
    filePath
} = {}) {
    const clsPath = filePath;
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

    return buildMethodPreviewUnit({
        metadataName,
        filePath: clsPath,
        metaXmlPath: metaPath,
        mergeBaseSha: mergeBase,
        clsThreeWay: clsMerge.threeWay,
        metaMerge
    });
}

function resolveMethodMergeUnit(unit, resolution = {}) {
    const incoming = resolution.methodResolutions || [];

    if (!incoming.length) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            `METHOD resolution for ${unit.metadataName} requires methodResolutions.`,
            { metadataName: unit.metadataName }
        );
    }

    const clsThreeWay = unit.threeWay?.cls;

    if (!clsThreeWay?.source) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_THREE_WAY_ARTIFACTS,
            `Missing stored three-way .cls for ${unit.metadataName}.`
        );
    }

    const combinedResolutions = mergeStoredMethodResolutions(
        unit.methodMerge?.methodResolutions,
        incoming
    );

    const comparison = compareApexMethodMerge({
        baseContent: clsThreeWay.base ?? '',
        sourceContent: clsThreeWay.source,
        destinationContent: clsThreeWay.destination ?? ''
    });

    assertResolvableMethodKeys(comparison.methods, incoming);
    assertResolutionTargetsAreConflicts(comparison.methods, incoming);

    applyMethodResolutions(
        comparison.methods,
        combinedResolutions,
        comparison.maps.source,
        comparison.maps.destination
    );

    const conflictCount = comparison.methods.filter(
        (entry) => entry.status === METHOD_STATUS.CONFLICT
    ).length;

    const methodMerge = {
        methods: mapMethodInventoryForClient(
            comparison.methods,
            comparison.maps
        ),
        conflictCount,
        resolved: conflictCount === 0,
        composeSuccess: false,
        methodResolutions: combinedResolutions
    };

  let nextUnit = {
        ...unit,
        mergeMode: METHOD_MERGE_MODE,
        methodMerge,
        conflictState: conflictCount > 0 ? 'UNRESOLVED' : 'RESOLVED'
    };

    if (conflictCount === 0) {
        composeApexMethodMerge(comparison, clsThreeWay.source);
        const composedCls = comparison.composedSource;

        nextUnit = applyResolvedArtifacts(nextUnit, {
            cls: composedCls,
            metaXml: unit.artifacts?.metaXml?.content ?? ''
        });
        nextUnit.methodMerge.composeSuccess = true;
        nextUnit.conflictState = 'RESOLVED';
    } else {
        nextUnit.artifacts = {
            ...unit.artifacts,
            cls: {
                content: null,
                conflict: true,
                sha256: null
            }
        };
    }

    return nextUnit;
}

function validateMethodUnitForSeal(unit) {
    if (unit.mergeMode !== METHOD_MERGE_MODE) {
        return;
    }

    if (unit.methodMerge?.conflictCount > 0 || unit.conflictState === 'UNRESOLVED') {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `Class ${unit.metadataName} has unresolved method conflicts.`,
            {
                metadataName: unit.metadataName,
                conflictCount: unit.methodMerge?.conflictCount
            }
        );
    }

    const clsContent = unit.artifacts?.cls?.content;

    if (!clsContent) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_REQUIRED_ARTIFACT,
            `Class ${unit.metadataName} is missing composed .cls content.`
        );
    }

    const parsed = parseApexClassSource(clsContent);
    const members = rootCallableMembers(parsed);
    const seen = new Set();

    for (const member of members) {
        if (seen.has(member.identityKey)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_DUPLICATE_IDENTITY,
                `Sealed METHOD class ${unit.metadataName} contains duplicate method identity ${member.identityKey}.`
            );
        }

        seen.add(member.identityKey);
    }

    const expectedKeys = new Set(
        (unit.methodMerge?.methods || [])
            .filter((entry) => entry.included !== false)
            .map((entry) => entry.methodKey)
    );

    validateComposedMethodMerge(clsContent, expectedKeys);
}

module.exports = {
    METHOD_MERGE_MODE,
    normalizeMergeMode,
    shouldUseMethodMode,
    mapMethodInventoryForClient,
    implementationTextFromMap,
    buildMethodConflictSummaries,
    buildMethodMergeState,
    runMethodMergeComparison,
    buildMethodPreviewUnit,
    previewApexClassMethod,
    resolveMethodMergeUnit,
    validateMethodUnitForSeal,
    mergeStoredMethodResolutions,
    METHOD_RESOLUTION_STRATEGY
};