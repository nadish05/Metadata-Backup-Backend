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
    DECLARATION_STATUS,
    DECLARATION_RESOLUTION_SIDE,
    compareApexMethodMerge,
    applyMethodResolutions,
    assertResolvableMethodResolutionKeys,
    assertMethodResolutionTargetsAreConflicts,
    methodResolutionStorageKey,
    applyDeclarationResolutions,
    mapDeclarationsForClient,
    countDeclarationConflicts,
    assertResolvableDeclarationKeys,
    assertDeclarationResolutionTargetsAreConflicts,
    applyNestedClassResolutions,
    assertResolvableNestedClassKeys,
    assertNestedClassResolutionTargetsAreConflicts,
    mapNestedClassesForClient,
    countNestedClassConflicts,
    computeMethodMergeReadiness,
    syncMethodMergeReadinessToComparison,
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

function implementationTextFromMap(memberMap, scopedMethodKey) {
    if (!memberMap || !memberMap.has(scopedMethodKey)) {
        return null;
    }

    const member = memberMap.get(scopedMethodKey);
    return member?.sourceText ?? null;
}

function mapMethodInventoryForClient(methods = [], implementationMaps = null) {
    const baseMap = implementationMaps?.base;
    const sourceMap = implementationMaps?.source;
    const destinationMap = implementationMaps?.destination;

    return methods.map((entry) => {
        const item = {
            methodKey: entry.methodKey,
            scopedMethodKey: entry.scopedMethodKey,
            declaringClassQualifiedName: entry.declaringClassQualifiedName,
            basePresent: entry.basePresent,
            sourcePresent: entry.sourcePresent,
            destinationPresent: entry.destinationPresent,
            status: entry.status,
            resolution: entry.resolution ?? null,
            included: entry.included !== false
        };

        if (entry.status === METHOD_STATUS.CONFLICT && implementationMaps) {
            item.baseImplementation = entry.basePresent
                ? implementationTextFromMap(baseMap, entry.scopedMethodKey)
                : null;
            item.sourceImplementation = entry.sourcePresent
                ? implementationTextFromMap(sourceMap, entry.scopedMethodKey)
                : null;
            item.destinationImplementation = entry.destinationPresent
                ? implementationTextFromMap(destinationMap, entry.scopedMethodKey)
                : null;
        }

        return item;
    });
}

function buildNestedClassConflictSummaries(metadataName, methodMerge) {
  if (!methodMerge?.nestedClasses?.length) {
        return [];
    }

    return methodMerge.nestedClasses
        .filter((entry) => entry.status === METHOD_STATUS.CONFLICT)
        .map((entry) => ({
            id: `${metadataName}:nested:${entry.qualifiedName}`,
            artifact: 'nested-class',
            qualifiedName: entry.qualifiedName,
            message: `Nested class ${entry.qualifiedName} has conflicting structural shells.`
        }));
}

function buildMethodConflictSummaries(metadataName, methodMerge) {
    if (!methodMerge?.methods?.length) {
        return [];
    }

    return methodMerge.methods
        .filter((entry) => entry.status === METHOD_STATUS.CONFLICT)
        .map((entry) => {
            const conflictId = entry.scopedMethodKey
                ? `${metadataName}:method:${entry.scopedMethodKey}`
                : `${metadataName}:method:${entry.methodKey}`;
            const label = entry.declaringClassQualifiedName
                ? `${entry.declaringClassQualifiedName}#${entry.methodKey}`
                : entry.methodKey;

            return {
                id: conflictId,
                artifact: 'method',
                methodKey: entry.methodKey,
                scopedMethodKey: entry.scopedMethodKey,
                declaringClassQualifiedName: entry.declaringClassQualifiedName,
                resolutionStatus: entry.status,
                message: `Method ${label} has conflicting implementations.`
            };
        });
}

function buildDeclarationConflictSummaries(metadataName, methodMerge) {
    const declarations = methodMerge?.declarations;

    if (!declarations) {
        return [];
    }

    return [declarations.access, declarations.sharing]
        .filter((entry) => entry?.status === DECLARATION_STATUS.CONFLICT)
        .map((entry) => ({
            id: `${metadataName}:${entry.conflictKey}`,
            artifact: 'declaration',
            conflictKey: entry.conflictKey,
            attribute: entry.attribute,
            message: `Class declaration ${entry.attribute} has conflicting values across branches.`
        }));
}

function buildMethodConflictSummariesAll(metadataName, methodMerge) {
    return [
        ...buildMethodConflictSummaries(metadataName, methodMerge),
        ...buildNestedClassConflictSummaries(metadataName, methodMerge),
        ...buildDeclarationConflictSummaries(metadataName, methodMerge)
    ];
}

function methodMergeHasUnresolvedDeclarationConflicts(methodMerge) {
    if (!methodMerge) {
        return false;
    }

    if ((methodMerge.declarationConflictCount ?? 0) > 0) {
        return true;
    }

    if (countDeclarationConflicts(methodMerge.declarations ?? {}) > 0) {
        return true;
    }

    if (methodMerge.declarationsResolved === false) {
        const noCallableConflicts =
            (methodMerge.conflictCount ?? 0) === 0 &&
            (methodMerge.nestedClassConflictCount ?? 0) === 0;

        if (noCallableConflicts) {
            return true;
        }
    }

    return false;
}

function buildMethodMergeState(mergeResult) {
    const readiness = computeMethodMergeReadiness({
        nestedClasses: mergeResult.nestedClasses,
        methods: mergeResult.methods,
        sourceParsed: mergeResult.parses?.source,
        destinationParsed: mergeResult.parses?.destination,
        sourceMap: mergeResult.maps?.source,
        destMap: mergeResult.maps?.destination,
        declarations: mergeResult.declarations
    });
    const nestedClassConflictCount = readiness.nestedClassConflictCount;
    const declarationConflictCount = readiness.declarationConflictCount;

    return {
        methods: mapMethodInventoryForClient(
            mergeResult.methods,
            mergeResult.maps
        ),
        nestedClasses: mapNestedClassesForClient(mergeResult.nestedClasses),
        nestedClassConflictCount,
        nestedClassComposeReady: readiness.nestedClassComposeReady,
        declarations: mapDeclarationsForClient(mergeResult.declarations),
        declarationConflictCount,
        declarationInventories: mergeResult.declarationInventories,
        declarationsResolved: declarationConflictCount === 0,
        conflictCount: readiness.conflictCount,
        resolved: readiness.conflictsResolved,
        compositionReady: readiness.compositionReady,
        composeSuccess: mergeResult.composeSuccess === true,
        methodResolutions: [],
        declarationResolutions: [],
        nestedClassResolutions: []
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

function mergeStoredDeclarationResolutions(
    existingResolutions = [],
    incomingResolutions = []
) {
    const byKey = new Map();

    for (const entry of existingResolutions || []) {
        if (entry?.conflictKey) {
            byKey.set(entry.conflictKey, entry);
        }
    }

    for (const entry of incomingResolutions || []) {
        if (entry?.conflictKey) {
            byKey.set(entry.conflictKey, entry);
        }
    }

    return [...byKey.values()];
}

function mergeStoredNestedClassResolutions(
    existingResolutions = [],
    incomingResolutions = []
) {
    const byKey = new Map();

    for (const entry of existingResolutions || []) {
        if (entry?.qualifiedName) {
            byKey.set(entry.qualifiedName, entry);
        }
    }

    for (const entry of incomingResolutions || []) {
        if (entry?.qualifiedName) {
            byKey.set(entry.qualifiedName, entry);
        }
    }

    return [...byKey.values()];
}

function mergeStoredMethodResolutions(
    existingResolutions = [],
    incomingResolutions = [],
    rootQualifiedName
) {
    const byKey = new Map();

    for (const entry of existingResolutions || []) {
        const storageKey = methodResolutionStorageKey(entry, rootQualifiedName);

        if (storageKey) {
            byKey.set(storageKey, entry);
        }
    }

    for (const entry of incomingResolutions || []) {
        const storageKey = methodResolutionStorageKey(entry, rootQualifiedName);

        if (storageKey) {
            byKey.set(storageKey, entry);
        }
    }

    return [...byKey.values()];
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
        conflictState: (() => {
            const previewReadiness = computeMethodMergeReadiness({
                nestedClasses: mergeResult.nestedClasses,
                methods: mergeResult.methods,
                sourceParsed: mergeResult.parses?.source,
                destinationParsed: mergeResult.parses?.destination,
                sourceMap: mergeResult.maps?.source,
                destMap: mergeResult.maps?.destination,
                declarations: mergeResult.declarations
            });
            return previewReadiness.compositionReady ? 'NONE' : 'UNRESOLVED';
        })(),
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
                conflict:
                    computeMethodMergeReadiness({
                        nestedClasses: mergeResult.nestedClasses,
                        methods: mergeResult.methods,
                        sourceParsed: mergeResult.parses?.source,
                        destinationParsed: mergeResult.parses?.destination,
                        sourceMap: mergeResult.maps?.source,
                        destMap: mergeResult.maps?.destination,
                        declarations: mergeResult.declarations
                    }).compositionReady !== true,
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
    const incomingMethods = resolution.methodResolutions || [];
    const incomingDeclarations = resolution.declarationResolutions || [];
    const incomingNested = resolution.nestedClassResolutions || [];

    if (
        !incomingMethods.length &&
        !incomingDeclarations.length &&
        !incomingNested.length
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            `METHOD resolution for ${unit.metadataName} requires methodResolutions, declarationResolutions, and/or nestedClassResolutions.`,
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

    const comparison = compareApexMethodMerge({
        baseContent: clsThreeWay.base ?? '',
        sourceContent: clsThreeWay.source,
        destinationContent: clsThreeWay.destination ?? ''
    });
    const rootQualifiedName = comparison.className;

    const combinedMethodResolutions = mergeStoredMethodResolutions(
        unit.methodMerge?.methodResolutions,
        incomingMethods,
        rootQualifiedName
    );
    const combinedDeclarationResolutions = mergeStoredDeclarationResolutions(
        unit.methodMerge?.declarationResolutions,
        incomingDeclarations
    );
    const combinedNestedClassResolutions = mergeStoredNestedClassResolutions(
        unit.methodMerge?.nestedClassResolutions,
        incomingNested
    );

    if (incomingMethods.length) {
        assertResolvableMethodResolutionKeys(
            comparison.methods,
            incomingMethods,
            rootQualifiedName
        );
        assertMethodResolutionTargetsAreConflicts(
            comparison.methods,
            incomingMethods,
            rootQualifiedName
        );
    }

    if (incomingDeclarations.length) {
        assertResolvableDeclarationKeys(
            comparison.declarations,
            incomingDeclarations
        );
        assertDeclarationResolutionTargetsAreConflicts(
            comparison.declarations,
            incomingDeclarations
        );
    }

    if (incomingNested.length) {
        assertResolvableNestedClassKeys(
            comparison.nestedClasses,
            incomingNested
        );
        assertNestedClassResolutionTargetsAreConflicts(
            comparison.nestedClasses,
            incomingNested
        );
    }

    applyDeclarationResolutions(
        comparison.declarations,
        combinedDeclarationResolutions,
        comparison.declarationInventories
    );

    applyMethodResolutions(
        comparison.methods,
        combinedMethodResolutions,
        comparison.maps.source,
        comparison.maps.destination,
        rootQualifiedName
    );

    applyNestedClassResolutions(
        comparison.nestedClasses,
        combinedNestedClassResolutions
    );

    const readiness = syncMethodMergeReadinessToComparison(comparison);
    const conflictCount = readiness.conflictCount;
    const nestedClassConflictCount = readiness.nestedClassConflictCount;
    const declarationConflictCount = readiness.declarationConflictCount;

    const methodMerge = {
        methods: mapMethodInventoryForClient(
            comparison.methods,
            comparison.maps
        ),
        nestedClasses: mapNestedClassesForClient(comparison.nestedClasses),
        nestedClassConflictCount,
        nestedClassComposeReady: readiness.nestedClassComposeReady,
        declarations: mapDeclarationsForClient(comparison.declarations),
        declarationConflictCount,
        declarationInventories: comparison.declarationInventories,
        declarationsResolved: declarationConflictCount === 0,
        conflictCount,
        resolved: readiness.conflictsResolved,
        compositionReady: readiness.compositionReady,
        composeSuccess: false,
        methodResolutions: combinedMethodResolutions,
        declarationResolutions: combinedDeclarationResolutions,
        nestedClassResolutions: combinedNestedClassResolutions
    };

    let nextUnit = {
        ...unit,
        mergeMode: METHOD_MERGE_MODE,
        methodMerge,
        conflictState: readiness.compositionReady ? 'RESOLVED' : 'UNRESOLVED'
    };

    if (readiness.compositionReady) {
        composeApexMethodMerge(
            comparison,
            clsThreeWay.source,
            clsThreeWay.destination ?? ''
        );
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

    if (unit.methodMerge?.conflictCount > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `Class ${unit.metadataName} has unresolved method conflicts.`,
            {
                metadataName: unit.metadataName,
                conflictCount: unit.methodMerge?.conflictCount
            }
        );
    }

    if (unit.methodMerge?.nestedClassConflictCount > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `Class ${unit.metadataName} has unresolved nested class conflicts.`,
            {
                metadataName: unit.metadataName,
                nestedClassConflictCount: unit.methodMerge?.nestedClassConflictCount
            }
        );
    }

    if (methodMergeHasUnresolvedDeclarationConflicts(unit.methodMerge)) {
        throw new ApexMergeError(
            MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT,
            `Class ${unit.metadataName} has unresolved declaration conflicts.`,
            {
                metadataName: unit.metadataName,
                declarationConflictCount: unit.methodMerge?.declarationConflictCount,
                declarations: unit.methodMerge?.declarations
            }
        );
    }

    if (unit.methodMerge?.compositionReady !== true) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Class ${unit.metadataName} cannot be sealed until METHOD merge is composition-ready.`,
            {
                metadataName: unit.metadataName,
                nestedClassComposeReady: unit.methodMerge?.nestedClassComposeReady,
                compositionReady: unit.methodMerge?.compositionReady
            }
        );
    }

    if (unit.conflictState === 'UNRESOLVED') {
        throw new ApexMergeError(
            MERGE_ERROR.UNRESOLVED_CONFLICT,
            `Class ${unit.metadataName} has unresolved merge conflicts.`,
            { metadataName: unit.metadataName, conflictState: unit.conflictState }
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
            .filter(
                (entry) =>
                    entry.included !== false &&
                    entry.declaringClassQualifiedName === unit.metadataName
            )
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
    buildNestedClassConflictSummaries,
    buildDeclarationConflictSummaries,
    buildMethodConflictSummariesAll,
    buildMethodMergeState,
    runMethodMergeComparison,
    buildMethodPreviewUnit,
    previewApexClassMethod,
    resolveMethodMergeUnit,
    validateMethodUnitForSeal,
    methodMergeHasUnresolvedDeclarationConflicts,
    mergeStoredMethodResolutions,
    mergeStoredDeclarationResolutions,
    METHOD_RESOLUTION_STRATEGY,
    DECLARATION_RESOLUTION_SIDE
};