'use strict';

const {
    parseApexClassSource,
    reconstructOuterClassDeclaration,
    OUTER_ACCESS
} = require('./apexClassParser.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    normalizeBodyText,
    rootCallableMembers
} = require('./apexMergeMethodComposer.shared');

function findRootClassClosingBraceIndex(sourceText, classDeclarationStart) {
    let depth = 0;
    let started = false;
    const startIndex = Math.max(0, Number(classDeclarationStart) || 0);

    for (let index = startIndex; index < sourceText.length; index += 1) {
        const character = sourceText[index];

        if (character === '{') {
            depth += 1;
            started = true;
        } else if (character === '}') {
            depth -= 1;

            if (started && depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

function rootQualifiedName(parsed) {
    return parsed.primaryClassName;
}

/**
 * Compose final Apex class from Source shell and selected method source slices.
 *
 * @param {object} params
 * @param {string} params.sourceText
 * @param {object} params.sourceParse
 * @param {Map<string, string>} params.selectedMethodTextByKey
 * @param {string[]} params.appendMethodTexts
 * @returns {string}
 */
function composeMethodMergedClass({
    sourceText,
    sourceParse,
    selectedMethodTextByKey,
    removedMethodKeys = new Set(),
    appendMethodTexts = []
}) {
    const root = sourceParse.classes.find((entry) => entry.isRoot);

    if (!root) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            'Root class not found in Source parse result.'
        );
    }

    let result = String(sourceText);
    const rootMembers = rootCallableMembers(sourceParse);
    const sortedForSplice = [...rootMembers].sort(
        (left, right) => right.sourceRange.start - left.sourceRange.start
    );

    for (const member of sortedForSplice) {
        const key = member.identityKey;

        if (removedMethodKeys.has(key)) {
            result =
                result.slice(0, member.sourceRange.start) +
                result.slice(member.sourceRange.end);
            continue;
        }

        if (!selectedMethodTextByKey.has(key)) {
            continue;
        }

        const selected = selectedMethodTextByKey.get(key);

        if (normalizeBodyText(selected) !== normalizeBodyText(member.sourceText)) {
            result =
                result.slice(0, member.sourceRange.start) +
                selected +
                result.slice(member.sourceRange.end);
        }
    }

    if (appendMethodTexts.length) {
        const closingBraceIndex = findRootClassClosingBraceIndex(
            result,
            root.classDeclaration.start
        );

        if (closingBraceIndex < 0 || result[closingBraceIndex] !== '}') {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                'Unable to locate root class closing brace for method append.'
            );
        }

        const padding =
            appendMethodTexts.length === 1 ? '\n    ' : '\n    ';
        const injection =
            padding +
            appendMethodTexts.join('\n\n    ') +
            (appendMethodTexts.length ? '\n' : '');

        result =
            result.slice(0, closingBraceIndex) +
            injection +
            result.slice(closingBraceIndex);
    }

    return result;
}

/**
 * Reparse composed source and verify duplicate-free root callable identities.
 *
 * @param {string} composedSource
 * @param {Set<string>} expectedMethodKeys
 * @returns {object}
 */
function validateComposedMethodMerge(composedSource, expectedMethodKeys) {
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

    const members = rootCallableMembers(parsed);
    const seen = new Set();

    for (const member of members) {
        if (seen.has(member.identityKey)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_DUPLICATE_IDENTITY,
                `Duplicate method identity in composed class: ${member.identityKey}`
            );
        }

        seen.add(member.identityKey);
    }

    for (const key of expectedMethodKeys) {
        if (!seen.has(key)) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Expected method missing from composed class: ${key}`
            );
        }
    }

    return parsed;
}

function normalizeStructuralText(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function collectRootStructuralBodySnapshot(parsed) {
    const root = parsed.classes.find((entry) => entry.isRoot);
    const qn = parsed.primaryClassName;

    if (!root || !parsed.outerDeclaration) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            'Composed class structural snapshot is incomplete.'
        );
    }

    return {
        className: parsed.primaryClassName,
        nonMergeableHeaderFingerprint: normalizeStructuralText(
            parsed.outerDeclaration.nonMergeableHeaderText
        ),
        fields: root.fields
            .map((field) => normalizeStructuralText(field.sourceText))
            .sort(),
        properties: root.properties
            .map((property) => normalizeStructuralText(property.sourceText))
            .sort(),
        innerClasses: parsed.classes
            .filter((entry) => entry.parentQualifiedName === qn)
            .map((entry) => normalizeStructuralText(entry.classDeclaration.text))
            .sort()
    };
}

/**
 * Apply selected outer declaration values after method composition.
 *
 * @param {string} composedSource
 * @param {{ access: string, sharing: string }} selection
 * @returns {string}
 */
function applyOuterDeclarationToComposedClass(composedSource, selection) {
    const allowedAccess = new Set([
        OUTER_ACCESS.PUBLIC,
        OUTER_ACCESS.GLOBAL,
        OUTER_ACCESS.UNSPECIFIED
    ]);

    if (!allowedAccess.has(selection.access)) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Unsupported outer access for METHOD composition: ${selection.access}`,
            { access: selection.access, sharing: selection.sharing }
        );
    }

    try {
        return reconstructOuterClassDeclaration(composedSource, {
            access: selection.access,
            sharing: selection.sharing
        });
    } catch (error) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Declaration reconstruction failed: ${error.message}`,
            {
                access: selection.access,
                sharing: selection.sharing,
                cause: error
            }
        );
    }
}

/**
 * Validate final composed class declaration and preserved structure.
 *
 * @param {object} params
 * @param {string} params.composedSource
 * @param {object} params.sourceParse
 * @param {string} params.expectedClassName
 * @param {string} params.selectedAccess
 * @param {string} params.selectedSharing
 * @param {Set<string>} params.expectedMethodKeys
 * @returns {object}
 */
function validateComposedDeclarationMerge({
    composedSource,
    sourceParse,
    expectedClassName,
    selectedAccess,
    selectedSharing,
    expectedMethodKeys,
    skipInnerClassStructuralSnapshot = false
}) {
    const parsed = validateComposedMethodMerge(composedSource, expectedMethodKeys);

    if (parsed.primaryClassName !== expectedClassName) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Composed class name "${parsed.primaryClassName}" does not match expected "${expectedClassName}".`,
            { expectedClassName, composedClassName: parsed.primaryClassName }
        );
    }

    if (parsed.outerDeclaration.access !== selectedAccess) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Composed access "${parsed.outerDeclaration.access}" does not match selected "${selectedAccess}".`,
            {
                attribute: 'access',
                selectedAccess,
                composedAccess: parsed.outerDeclaration.access
            }
        );
    }

    if (parsed.outerDeclaration.sharing !== selectedSharing) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Composed sharing "${parsed.outerDeclaration.sharing}" does not match selected "${selectedSharing}".`,
            {
                attribute: 'sharing',
                selectedSharing,
                composedSharing: parsed.outerDeclaration.sharing
            }
        );
    }

    if (!skipInnerClassStructuralSnapshot) {
        const sourceSnapshot = collectRootStructuralBodySnapshot(sourceParse);
        const composedSnapshot = collectRootStructuralBodySnapshot(parsed);

        const fields = [
            'nonMergeableHeaderFingerprint',
            'fields',
            'properties',
            'innerClasses'
        ];

        for (const field of fields) {
            if (
                JSON.stringify(sourceSnapshot[field]) !==
                JSON.stringify(composedSnapshot[field])
            ) {
                throw new ApexMergeError(
                    MERGE_ERROR.METHOD_COMPOSE_FAILED,
                    `Composed class structural field "${field}" changed during declaration reconstruction.`,
                    {
                        field,
                        source: sourceSnapshot[field],
                        composed: composedSnapshot[field]
                    }
                );
            }
        }
    } else {
        const composedSnapshot = collectRootStructuralBodySnapshot(parsed);
        const sourceSnapshot = collectRootStructuralBodySnapshot(sourceParse);

        for (const field of ['nonMergeableHeaderFingerprint', 'fields', 'properties']) {
            if (
                JSON.stringify(sourceSnapshot[field]) !==
                JSON.stringify(composedSnapshot[field])
            ) {
                throw new ApexMergeError(
                    MERGE_ERROR.METHOD_COMPOSE_FAILED,
                    `Composed class structural field "${field}" changed during declaration reconstruction.`,
                    {
                        field,
                        source: sourceSnapshot[field],
                        composed: composedSnapshot[field]
                    }
                );
            }
        }
    }

    return parsed;
}

const {
    composeMethodMergedClassRecursive,
    validateComposedRecursiveMethodMerge
} = require('./apexMergeMethodComposer.nested');

module.exports = {
    composeMethodMergedClass,
    composeMethodMergedClassRecursive,
    validateComposedMethodMerge,
    validateComposedRecursiveMethodMerge,
    validateComposedDeclarationMerge,
    applyOuterDeclarationToComposedClass,
    collectRootStructuralBodySnapshot,
    normalizeBodyText,
    rootCallableMembers
};