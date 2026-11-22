'use strict';

const { parseApexClassSource } = require('./apexClassParser.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    normalizeBodyText,
    rootCallableMembers
} = require('./apexMergeMethodComposer.shared');

const METHOD_STATUS = Object.freeze({
    AUTO_INCLUDED: 'AUTO_INCLUDED',
    AUTO_EXCLUDED: 'AUTO_EXCLUDED',
    CONFLICT: 'CONFLICT',
    RESOLVED: 'RESOLVED'
});

const METHOD_RESOLUTION_STRATEGY = Object.freeze({
    ACCEPT_SOURCE: 'ACCEPT_SOURCE',
    ACCEPT_TARGET: 'ACCEPT_TARGET'
});

function extractNestedMemberHeader(classInfo, fileText) {
    if (
        !classInfo?.memberDeclarationRange ||
        classInfo.classBodyOpenBraceIndex == null
    ) {
        return null;
    }

    const start = classInfo.memberDeclarationRange.start;
    const end = classInfo.classBodyOpenBraceIndex + 1;

    return {
        start,
        end,
        text: String(fileText).slice(start, end)
    };
}

function findClassInfo(parsed, qualifiedName, rootQualifiedName) {
    if (!parsed) {
        return null;
    }

    if (qualifiedName === rootQualifiedName) {
        return parsed.classes.find((entry) => entry.isRoot) || null;
    }

    return (
        parsed.classes.find(
            (entry) => entry.qualifiedName === qualifiedName && !entry.isRoot
        ) || null
    );
}

function resolveChosenMethodText(item, sourceMap, destMap) {
    if (item.chosenImplementation) {
        return item.chosenImplementation;
    }

    if (!item.included || item.status === METHOD_STATUS.AUTO_EXCLUDED) {
        return null;
    }

    if (item.status === METHOD_STATUS.RESOLVED) {
        const side =
            item.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? sourceMap
                : destMap;

        return side.get(item.scopedMethodKey)?.sourceText ?? null;
    }

    if (item.status === METHOD_STATUS.AUTO_INCLUDED) {
        const primary =
            item.chosenFrom === 'destination' ? destMap : sourceMap;
        const text = primary.get(item.scopedMethodKey)?.sourceText;

        if (text) {
            return text;
        }

        return (item.chosenFrom === 'destination' ? sourceMap : destMap).get(
            item.scopedMethodKey
        )?.sourceText;
    }

    return null;
}

function collectMethodEdits(
    methods,
    sourceMap,
    destMap,
    rootQualifiedName,
    nestedClasses = []
) {
    const resolvedDeclaringClasses = new Set(
        (nestedClasses || [])
            .filter((entry) => entry.status === METHOD_STATUS.RESOLVED)
            .map((entry) => entry.qualifiedName)
    );
    const edits = [];
    const expectedScopedKeys = new Set();
    const excludedScopedKeys = new Set();

    for (const item of methods || []) {
        if (resolvedDeclaringClasses.has(item.declaringClassQualifiedName)) {
            expectedScopedKeys.add(item.scopedMethodKey);
            continue;
        }
        if (item.status === METHOD_STATUS.CONFLICT) {
            continue;
        }

        if (item.status === METHOD_STATUS.AUTO_EXCLUDED || !item.included) {
            if (sourceMap.has(item.scopedMethodKey)) {
                const member = sourceMap.get(item.scopedMethodKey);
                excludedScopedKeys.add(item.scopedMethodKey);
                edits.push({
                    kind: 'splice',
                    start: member.sourceRange.start,
                    end: member.sourceRange.end,
                    replacement: '',
                    scopedMethodKey: item.scopedMethodKey
                });
            }

            continue;
        }

        const selectedText = resolveChosenMethodText(item, sourceMap, destMap);

        if (!selectedText) {
            continue;
        }

        expectedScopedKeys.add(item.scopedMethodKey);

        if (sourceMap.has(item.scopedMethodKey)) {
            const member = sourceMap.get(item.scopedMethodKey);

            if (
                normalizeBodyText(selectedText) !==
                normalizeBodyText(member.sourceText)
            ) {
                edits.push({
                    kind: 'splice',
                    start: member.sourceRange.start,
                    end: member.sourceRange.end,
                    replacement: selectedText,
                    scopedMethodKey: item.scopedMethodKey
                });
            }
        } else {
            edits.push({
                kind: 'appendMember',
                parentQualifiedName: item.declaringClassQualifiedName,
                replacement: selectedText,
                scopedMethodKey: item.scopedMethodKey,
                siblingOrder: null
            });
        }
    }

    const expectedRootMethodKeys = new Set();

    for (const scopedKey of expectedScopedKeys) {
        const item = methods.find((entry) => entry.scopedMethodKey === scopedKey);

        if (item?.declaringClassQualifiedName === rootQualifiedName) {
            expectedRootMethodKeys.add(item.methodKey);
        }
    }

    return {
        edits,
        expectedScopedKeys,
        excludedScopedKeys,
        expectedRootMethodKeys
    };
}

function collectNestedClassEdits(
    nestedClasses,
    sourceParse,
    destinationParse,
    rootQualifiedName,
    sourceText,
    destinationText
) {
    const edits = [];
    const retainedQualifiedNames = new Set();
    const excludedQualifiedNames = new Set();

    for (const entry of nestedClasses || []) {
        if (entry.status === METHOD_STATUS.CONFLICT) {
            continue;
        }

        if (entry.status === METHOD_STATUS.AUTO_EXCLUDED || !entry.included) {
            excludedQualifiedNames.add(entry.qualifiedName);

            const srcInfo = findClassInfo(
                sourceParse,
                entry.qualifiedName,
                rootQualifiedName
            );

            if (srcInfo?.memberDeclarationRange) {
                edits.push({
                    kind: 'splice',
                    start: srcInfo.memberDeclarationRange.start,
                    end: srcInfo.memberDeclarationRange.end,
                    replacement: '',
                    qualifiedName: entry.qualifiedName
                });
            }

            continue;
        }

        retainedQualifiedNames.add(entry.qualifiedName);

        const srcInfo = findClassInfo(
            sourceParse,
            entry.qualifiedName,
            rootQualifiedName
        );
        const dstInfo = findClassInfo(
            destinationParse,
            entry.qualifiedName,
            rootQualifiedName
        );

        if (entry.status === METHOD_STATUS.RESOLVED) {
            const chosenInfo =
                entry.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                    ? srcInfo
                    : dstInfo;

            if (!chosenInfo?.memberDeclarationRange?.text) {
                throw new ApexMergeError(
                    MERGE_ERROR.METHOD_COMPOSE_FAILED,
                    `Resolved nested class ${entry.qualifiedName} is missing on the chosen side.`,
                    { qualifiedName: entry.qualifiedName }
                );
            }

            const chosenText = chosenInfo.memberDeclarationRange.text;

            if (srcInfo?.memberDeclarationRange) {
                if (
                    normalizeBodyText(chosenText) !==
                    normalizeBodyText(srcInfo.memberDeclarationRange.text)
                ) {
                    edits.push({
                        kind: 'splice',
                        start: srcInfo.memberDeclarationRange.start,
                        end: srcInfo.memberDeclarationRange.end,
                        replacement: chosenText,
                        qualifiedName: entry.qualifiedName
                    });
                }
            } else {
                edits.push({
                    kind: 'appendNestedClass',
                    parentQualifiedName: entry.parentQualifiedName,
                    replacement: chosenText,
                    qualifiedName: entry.qualifiedName,
                    siblingOrder: chosenInfo.siblingOrder ?? 0
                });
            }

            continue;
        }

        if (!srcInfo && dstInfo?.memberDeclarationRange?.text) {
            edits.push({
                kind: 'appendNestedClass',
                parentQualifiedName: entry.parentQualifiedName,
                replacement: dstInfo.memberDeclarationRange.text,
                qualifiedName: entry.qualifiedName,
                siblingOrder: dstInfo.siblingOrder ?? 0
            });
            continue;
        }

        if (
            entry.status === METHOD_STATUS.AUTO_INCLUDED &&
            entry.sourcePresent &&
            entry.destinationPresent &&
            srcInfo &&
            dstInfo &&
            entry.sourceShell !== entry.destinationShell &&
            entry.chosenFrom
        ) {
            const chosenFromDestination = entry.chosenFrom === 'destination';
            const chosenInfo = chosenFromDestination ? dstInfo : srcInfo;
            const chosenFile = chosenFromDestination
                ? destinationText
                : sourceText;
            const chosenHeader = extractNestedMemberHeader(
                chosenInfo,
                chosenFile
            );
            const sourceHeader = extractNestedMemberHeader(srcInfo, sourceText);

            if (
                chosenHeader &&
                sourceHeader &&
                normalizeBodyText(chosenHeader.text) !==
                    normalizeBodyText(sourceHeader.text)
            ) {
                edits.push({
                    kind: 'splice',
                    start: sourceHeader.start,
                    end: sourceHeader.end,
                    replacement: chosenHeader.text,
                    qualifiedName: entry.qualifiedName,
                    fragment: 'header'
                });
            }
        }
    }

    return { edits, retainedQualifiedNames, excludedQualifiedNames };
}

function assertNonOverlappingEdits(edits) {
    const splices = edits
        .filter((edit) => edit.kind === 'splice')
        .sort((left, right) => left.start - right.start);

    for (let index = 1; index < splices.length; index += 1) {
        const prior = splices[index - 1];
        const current = splices[index];

        if (current.start < prior.end) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                'Overlapping composition edits detected.',
                { prior, current }
            );
        }
    }
}

function applySpliceEdits(sourceText, edits) {
    const splices = [...edits]
        .filter((edit) => edit.kind === 'splice')
        .sort((left, right) => right.start - left.start);
    let result = String(sourceText);

    for (const edit of splices) {
        if (edit.start < 0 || edit.end < edit.start || edit.end > result.length) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                'Composition edit range is out of bounds.',
                { edit, length: result.length }
            );
        }

        result =
            result.slice(0, edit.start) +
            edit.replacement +
            result.slice(edit.end);
    }

    return result;
}

function applyAppendEdits(sourceText, sourceParse, appendEdits, rootQualifiedName) {
    let result = String(sourceText);
    let workingParse = sourceParse;
    const appendsByParent = new Map();

    for (const edit of appendEdits) {
        const list = appendsByParent.get(edit.parentQualifiedName) || [];
        list.push(edit);
        appendsByParent.set(edit.parentQualifiedName, list);
    }

    const parentQualifiedNames = [...appendsByParent.keys()].sort(
        (left, right) => right.split('.').length - left.split('.').length
    );

    for (const parentQualifiedName of parentQualifiedNames) {
        const parentInfo = findClassInfo(
            workingParse,
            parentQualifiedName,
            rootQualifiedName
        );

        if (!parentInfo) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Unable to locate parent class ${parentQualifiedName} for composition append.`,
                { parentQualifiedName }
            );
        }

        const closeIndex =
            parentInfo.classBodyCloseBraceIndex ??
            parentInfo.classBodyRange?.end;

        if (closeIndex == null || closeIndex < 0 || closeIndex > result.length) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Unable to locate body close brace for ${parentQualifiedName}.`,
                { parentQualifiedName }
            );
        }

        const pending = appendsByParent
            .get(parentQualifiedName)
            .sort(
                (left, right) =>
                    (left.siblingOrder ?? 0) - (right.siblingOrder ?? 0)
            );
        const injection =
            `\n    ${pending.map((entry) => entry.replacement).join('\n\n    ')}\n`;

        result =
            result.slice(0, closeIndex) + injection + result.slice(closeIndex);

        try {
            workingParse = parseApexClassSource(result);
        } catch (error) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Intermediate composed Apex failed parse after append to ${parentQualifiedName}: ${error.message}`,
                { parentQualifiedName, cause: error }
            );
        }
    }

    return result;
}

function composeMethodMergedClassRecursive({
    sourceText,
    destinationText,
    sourceParse,
    destinationParse,
    methods,
    nestedClasses,
    sourceMap,
    destMap,
    rootQualifiedName
}) {
    const methodPlan = collectMethodEdits(
        methods,
        sourceMap,
        destMap,
        rootQualifiedName,
        nestedClasses
    );
    const nestedPlan = collectNestedClassEdits(
        nestedClasses,
        sourceParse,
        destinationParse,
        rootQualifiedName,
        sourceText,
        destinationText ?? sourceText
    );
    const allEdits = [...methodPlan.edits, ...nestedPlan.edits];

    assertNonOverlappingEdits(allEdits);

    let composed = applySpliceEdits(sourceText, allEdits);
    const appendEdits = allEdits.filter(
        (edit) =>
            edit.kind === 'appendMember' || edit.kind === 'appendNestedClass'
    );

    if (appendEdits.length) {
        composed = applyAppendEdits(
            composed,
            parseApexClassSource(composed),
            appendEdits,
            rootQualifiedName
        );
    }

    return {
        composedSource: composed,
        expectedRootMethodKeys: methodPlan.expectedRootMethodKeys,
        expectedScopedMethodKeys: methodPlan.expectedScopedKeys,
        excludedScopedMethodKeys: methodPlan.excludedScopedKeys,
        retainedNestedQualifiedNames: nestedPlan.retainedQualifiedNames,
        excludedNestedQualifiedNames: nestedPlan.excludedQualifiedNames
    };
}

function validateComposedRecursiveMethodMerge({
    composedSource,
    expectedRootMethodKeys,
    expectedScopedMethodKeys,
    excludedScopedMethodKeys,
    retainedNestedQualifiedNames,
    excludedNestedQualifiedNames,
    rootQualifiedName
}) {
    let parsed;

    try {
        parsed = parseApexClassSource(composedSource);
    } catch (error) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Composed Apex failed parse validation: ${error.message}`,
            { cause: error }
        );
    }

    const seenScoped = new Set();

    for (const member of parsed.methods) {
        if (member.kind !== 'method' && member.kind !== 'constructor') {
            continue;
        }

        const scoped = `${member.declaringClassQualifiedName}#${member.identityKey}`;

        if (seenScoped.has(scoped)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_DUPLICATE_IDENTITY,
                `Duplicate scoped method identity in composed class: ${scoped}`
            );
        }

        seenScoped.add(scoped);

        if (excludedScopedMethodKeys.has(scoped)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Excluded scoped method still present: ${scoped}`
            );
        }
    }

    for (const scopedKey of expectedScopedMethodKeys) {
        if (!seenScoped.has(scopedKey)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Expected scoped method missing from composed class: ${scopedKey}`
            );
        }
    }

    const rootMembers = rootCallableMembers(parsed);
    const seenRoot = new Set();

    for (const member of rootMembers) {
        if (seenRoot.has(member.identityKey)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_DUPLICATE_IDENTITY,
                `Duplicate root method identity in composed class: ${member.identityKey}`
            );
        }

        seenRoot.add(member.identityKey);
    }

    for (const key of expectedRootMethodKeys || []) {
        if (!seenRoot.has(key)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Expected root method missing from composed class: ${key}`
            );
        }
    }

    const nestedSeen = new Set();

    for (const entry of parsed.classes) {
        if (entry.isRoot) {
            continue;
        }

        if (nestedSeen.has(entry.qualifiedName)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Duplicate nested class identity: ${entry.qualifiedName}`
            );
        }

        nestedSeen.add(entry.qualifiedName);
    }

    for (const qualifiedName of retainedNestedQualifiedNames || []) {
        if (!nestedSeen.has(qualifiedName)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Expected nested class missing from composed output: ${qualifiedName}`
            );
        }
    }

    for (const qualifiedName of excludedNestedQualifiedNames || []) {
        if (nestedSeen.has(qualifiedName)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Excluded nested class still present: ${qualifiedName}`
            );
        }
    }

    const actualRootName = parsed.primaryClassName;

    if (actualRootName !== rootQualifiedName) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Composed class name "${actualRootName}" does not match expected "${rootQualifiedName}".`
        );
    }

    return parsed;
}

module.exports = {
    composeMethodMergedClassRecursive,
    validateComposedRecursiveMethodMerge,
    collectMethodEdits,
    collectNestedClassEdits
};