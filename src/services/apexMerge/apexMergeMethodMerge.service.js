'use strict';

const { parseApexClassSource } = require('./apexClassParser.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    composeMethodMergedClass,
    validateComposedMethodMerge,
    normalizeBodyText,
    rootCallableMembers
} = require('./apexMergeMethodComposer.service');

const METHOD_MERGE_MODE = 'METHOD';

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

function normalizeStructuralText(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function parseSide(label, source) {
    try {
        return parseApexClassSource(source);
    } catch (error) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Failed to parse ${label} Apex class: ${error.message}`,
            { side: label, cause: error }
        );
    }
}

function indexRootCallableMembers(parsed) {
    const map = new Map();

    for (const member of rootCallableMembers(parsed)) {
        map.set(member.identityKey, member);
    }

    return map;
}

function extractClassShellHeader(parsed) {
    const root = parsed.classes.find((entry) => entry.isRoot);

    if (!root) {
        return '';
    }

    const declarationText = root.classDeclaration?.text || '';
    const openBraceIndex = declarationText.indexOf('{');

    if (openBraceIndex < 0) {
        return normalizeStructuralText(declarationText);
    }

    return normalizeStructuralText(declarationText.slice(0, openBraceIndex + 1));
}

function collectStructuralSnapshot(parsed) {
    const root = parsed.classes.find((entry) => entry.isRoot);
    const qn = parsed.primaryClassName;

    if (!root) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'No root class found while collecting structural snapshot.'
        );
    }

    return {
        className: parsed.primaryClassName,
        classShellHeader: extractClassShellHeader(parsed),
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

function isAbsentClassContent(content) {
    return !String(content ?? '').trim();
}

function listStructuralMismatches(left, right) {
    const mismatches = [];

    if (left.className !== right.className) {
        mismatches.push('class name');
    }

    const compareFields = ['classShellHeader', 'fields', 'properties', 'innerClasses'];

    for (const field of compareFields) {
        const leftValue = JSON.stringify(left[field]);
        const rightValue = JSON.stringify(right[field]);

        if (leftValue !== rightValue) {
            mismatches.push(field);
        }
    }

    return mismatches;
}

function assertStructuralCompatibility(baseParsed, sourceParsed, destParsed) {
    const base = collectStructuralSnapshot(baseParsed);
    const source = collectStructuralSnapshot(sourceParsed);
    const dest = collectStructuralSnapshot(destParsed);

    const mismatches = [];

    if (base.className !== source.className || base.className !== dest.className) {
        mismatches.push('class name');
    }

    const compareFields = ['classShellHeader', 'fields', 'properties', 'innerClasses'];

    for (const field of compareFields) {
        const baseValue = JSON.stringify(base[field]);
        const sourceValue = JSON.stringify(source[field]);
        const destValue = JSON.stringify(dest[field]);

        if (
            baseValue !== sourceValue ||
            baseValue !== destValue ||
            sourceValue !== destValue
        ) {
            mismatches.push(field);
        }
    }

    if (mismatches.length) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT,
            `Unsupported class-level structural differences for METHOD merge: ${mismatches.join(
                ', '
            )}.`,
            { mismatches, base, source, destination: dest }
        );
    }
}

function assertStructuralCompatibilityWithoutBase(sourceParsed, destParsed) {
    const source = collectStructuralSnapshot(sourceParsed);
    const dest = collectStructuralSnapshot(destParsed);
    const mismatches = listStructuralMismatches(source, dest);

    if (mismatches.length) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT,
            `Unsupported class-level structural differences for METHOD merge: ${mismatches.join(
                ', '
            )}.`,
            { mismatches, base: null, source, destination: dest }
        );
    }
}

function memberBody(map, key) {
    const member = map.get(key);
    return member ? normalizeBodyText(member.sourceText) : null;
}

function chooseTextFromMap(map, key) {
    const member = map.get(key);
    return member ? member.sourceText : null;
}

/**
 * Three-way callable-member comparison for the root class (methods + constructors).
 */
function buildMethodInventory(baseMap, sourceMap, destMap) {
    const keys = new Set([
        ...baseMap.keys(),
        ...sourceMap.keys(),
        ...destMap.keys()
    ]);
    const inventory = [];

    for (const methodKey of [...keys].sort()) {
        const basePresent = baseMap.has(methodKey);
        const sourcePresent = sourceMap.has(methodKey);
        const destinationPresent = destMap.has(methodKey);

        const baseBody = memberBody(baseMap, methodKey);
        const sourceBody = memberBody(sourceMap, methodKey);
        const destinationBody = memberBody(destMap, methodKey);

        const entry = {
            methodKey,
            basePresent,
            sourcePresent,
            destinationPresent,
            status: METHOD_STATUS.AUTO_INCLUDED,
            resolution: null,
            included: true,
            chosenImplementation: null,
            chosenFrom: null
        };

        if (basePresent) {
            if (sourcePresent && destinationPresent) {
                if (sourceBody === baseBody && destinationBody === baseBody) {
                    entry.chosenImplementation = chooseTextFromMap(sourceMap, methodKey);
                    entry.chosenFrom = 'source';
                } else if (sourceBody !== baseBody && destinationBody === baseBody) {
                    entry.chosenImplementation = chooseTextFromMap(sourceMap, methodKey);
                    entry.chosenFrom = 'source';
                } else if (destinationBody !== baseBody && sourceBody === baseBody) {
                    entry.chosenImplementation = chooseTextFromMap(
                        destMap,
                        methodKey
                    );
                    entry.chosenFrom = 'destination';
                } else if (
                    sourceBody !== baseBody &&
                    destinationBody !== baseBody &&
                    sourceBody === destinationBody
                ) {
                    entry.chosenImplementation = chooseTextFromMap(sourceMap, methodKey);
                    entry.chosenFrom = 'source';
                } else if (
                    sourceBody !== baseBody &&
                    destinationBody !== baseBody &&
                    sourceBody !== destinationBody
                ) {
                    entry.status = METHOD_STATUS.CONFLICT;
                    entry.chosenImplementation = null;
                    entry.chosenFrom = null;
                }
            } else if (sourcePresent && !destinationPresent) {
                entry.status = METHOD_STATUS.CONFLICT;
                entry.included = true;
            } else if (!sourcePresent && destinationPresent) {
                entry.status = METHOD_STATUS.CONFLICT;
                entry.included = true;
            } else {
                entry.status = METHOD_STATUS.AUTO_EXCLUDED;
                entry.included = false;
                entry.chosenImplementation = null;
            }
        } else if (sourcePresent && destinationPresent) {
            if (sourceBody === destinationBody) {
                entry.chosenImplementation = chooseTextFromMap(sourceMap, methodKey);
                entry.chosenFrom = 'source';
            } else {
                entry.status = METHOD_STATUS.CONFLICT;
            }
        } else if (sourcePresent) {
            entry.chosenImplementation = chooseTextFromMap(sourceMap, methodKey);
            entry.chosenFrom = 'source';
        } else if (destinationPresent) {
            entry.chosenImplementation = chooseTextFromMap(destMap, methodKey);
            entry.chosenFrom = 'destination';
        }

        inventory.push(entry);
    }

    return inventory;
}

function countConflicts(inventory) {
    return inventory.filter((item) => item.status === METHOD_STATUS.CONFLICT).length;
}

function applyMethodResolutions(inventory, resolutions, sourceMap, destMap) {
    if (!resolutions || !resolutions.length) {
        return;
    }

    const byKey = new Map();

    for (const resolution of resolutions) {
        if (
            resolution.strategy !== METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE &&
            resolution.strategy !== METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_RESOLUTION_STRATEGY,
                `Unsupported METHOD resolution strategy: ${resolution.strategy}`,
                { resolution }
            );
        }

        byKey.set(resolution.methodKey, resolution.strategy);
    }

    for (const item of inventory) {
        if (item.status !== METHOD_STATUS.CONFLICT) {
            continue;
        }

        const strategy = byKey.get(item.methodKey);

        if (!strategy) {
            continue;
        }

        item.resolution = strategy;
        item.status = METHOD_STATUS.RESOLVED;
        item.chosenFrom =
            strategy === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? 'source'
                : 'destination';

        const sideMap =
            strategy === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? sourceMap
                : destMap;

        if (sideMap.has(item.methodKey)) {
            item.chosenImplementation = chooseTextFromMap(
                sideMap,
                item.methodKey
            );
            item.included = true;
        } else {
            item.chosenImplementation = null;
            item.included = false;
        }
    }
}

function buildSelectionMaps(inventory, sourceMap, destMap) {
    const selectedMethodTextByKey = new Map();
    const removedMethodKeys = new Set();
    const appendMethodTexts = [];
    const expectedKeys = new Set();

    for (const item of inventory) {
        if (item.status === METHOD_STATUS.AUTO_EXCLUDED) {
            continue;
        }

        if (item.status === METHOD_STATUS.CONFLICT) {
            continue;
        }

        if (!item.included) {
            if (sourceMap.has(item.methodKey)) {
                removedMethodKeys.add(item.methodKey);
            }
            continue;
        }

        const text =
            item.chosenImplementation ||
            (item.status === METHOD_STATUS.RESOLVED &&
            item.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? chooseTextFromMap(sourceMap, item.methodKey)
                : item.status === METHOD_STATUS.RESOLVED &&
                  item.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                ? chooseTextFromMap(destMap, item.methodKey)
                : null);

        if (!text) {
            continue;
        }

        expectedKeys.add(item.methodKey);

        if (sourceMap.has(item.methodKey)) {
            const sourceSlice = chooseTextFromMap(sourceMap, item.methodKey);

            if (normalizeBodyText(text) !== normalizeBodyText(sourceSlice)) {
                selectedMethodTextByKey.set(item.methodKey, text);
            }
        } else {
            appendMethodTexts.push(text);
        }
    }

    return {
        selectedMethodTextByKey,
        removedMethodKeys,
        appendMethodTexts,
        expectedKeys
    };
}

/**
 * Compare Base, Source, and Destination without composing.
 */
function compareApexMethodMerge({
    baseContent,
    sourceContent,
    destinationContent
}) {
    const baseAbsent = isAbsentClassContent(baseContent);
    const sourceParsed = parseSide('source', sourceContent);
    const destinationParsed = parseSide('destination', destinationContent);

    let baseParsed = null;
    let baseMap = new Map();

    if (baseAbsent) {
        assertStructuralCompatibilityWithoutBase(sourceParsed, destinationParsed);
    } else {
        baseParsed = parseSide('base', baseContent);
        assertStructuralCompatibility(baseParsed, sourceParsed, destinationParsed);
        baseMap = indexRootCallableMembers(baseParsed);
    }

    const sourceMap = indexRootCallableMembers(sourceParsed);
    const destMap = indexRootCallableMembers(destinationParsed);
    const methods = buildMethodInventory(baseMap, sourceMap, destMap);
    const conflictCount = countConflicts(methods);

    return {
        mergeMode: METHOD_MERGE_MODE,
        className: sourceParsed.primaryClassName,
        methods,
        conflictCount,
        resolved: conflictCount === 0,
        composeSuccess: false,
        composedSource: null,
        baseClassAbsent: baseAbsent,
        parses: {
            base: baseParsed,
            source: sourceParsed,
            destination: destinationParsed
        },
        maps: {
            base: baseMap,
            source: sourceMap,
            destination: destMap
        }
    };
}

/**
 * Apply resolutions (when provided) and compose final Source-shell class.
 */
function composeApexMethodMerge(comparison, sourceContent) {
    const unresolved = countConflicts(comparison.methods);

    if (unresolved > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `METHOD merge has ${unresolved} unresolved conflict(s).`,
            { conflictCount: unresolved, methods: comparison.methods }
        );
    }

    const {
        selectedMethodTextByKey,
        removedMethodKeys,
        appendMethodTexts,
        expectedKeys
    } = buildSelectionMaps(
        comparison.methods,
        comparison.maps.source,
        comparison.maps.destination
    );

    const composedSource = composeMethodMergedClass({
        sourceText: sourceContent,
        sourceParse: comparison.parses.source,
        selectedMethodTextByKey,
        removedMethodKeys,
        appendMethodTexts
    });

    validateComposedMethodMerge(composedSource, expectedKeys);

    comparison.composedSource = composedSource;
    comparison.composeSuccess = true;
    comparison.resolved = true;

    return comparison;
}

/**
 * End-to-end METHOD merge: compare, optional per-method resolution, compose.
 */
function executeApexMethodMerge({
    baseContent,
    sourceContent,
    destinationContent,
    resolutions = null
}) {
    const comparison = compareApexMethodMerge({
        baseContent,
        sourceContent,
        destinationContent
    });

    if (resolutions && resolutions.length) {
        applyMethodResolutions(
            comparison.methods,
            resolutions,
            comparison.maps.source,
            comparison.maps.destination
        );

        const remaining = countConflicts(comparison.methods);

        comparison.conflictCount = remaining;
        comparison.resolved = remaining === 0;
    }

    if (comparison.resolved) {
        composeApexMethodMerge(comparison, sourceContent);
    }

    return comparison;
}

module.exports = {
    METHOD_MERGE_MODE,
    METHOD_STATUS,
    METHOD_RESOLUTION_STRATEGY,
    compareApexMethodMerge,
    applyMethodResolutions,
    composeApexMethodMerge,
    executeApexMethodMerge,
    assertStructuralCompatibility,
    assertStructuralCompatibilityWithoutBase,
    isAbsentClassContent,
    buildMethodInventory,
    indexRootCallableMembers,
    collectStructuralSnapshot
};