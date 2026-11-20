'use strict';

const { parseApexClassSource, OUTER_ACCESS } = require('./apexClassParser.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    composeMethodMergedClass,
    applyOuterDeclarationToComposedClass,
    validateComposedDeclarationMerge,
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

const DECLARATION_STATUS = Object.freeze({
    AUTO_RESOLVED: 'AUTO_RESOLVED',
    CONFLICT: 'CONFLICT',
    RESOLVED: 'RESOLVED'
});

const DECLARATION_RESOLUTION_SIDE = Object.freeze({
    SOURCE: 'SOURCE',
    DESTINATION: 'DESTINATION'
});

const DECLARATION_ATTRIBUTE = Object.freeze({
    ACCESS: 'access',
    SHARING: 'sharing'
});

const KNOWN_DECLARATION_CONFLICT_KEYS = new Set([
    'declaration:access',
    'declaration:sharing'
]);

function normalizeStructuralText(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * Parser-backed fingerprint for a direct nested class (structural guard only).
 *
 * @param {object} classInfo Parsed class entry
 * @returns {string}
 */
function buildDirectNestedClassStructuralFingerprint(classInfo) {
    const meta = classInfo.nestedMemberDeclaration;

    if (!meta) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Missing nested class declaration metadata for ${classInfo.qualifiedName}.`
        );
    }

    const annotations = [...(meta.annotations || [])]
        .map((entry) => normalizeStructuralText(entry))
        .sort()
        .join(',');

    const parts = [
        `qn:${classInfo.qualifiedName}`,
        `access:${meta.accessModifier}`,
        `static:${meta.isStatic ? 1 : 0}`,
        `virtual:${meta.isVirtual ? 1 : 0}`,
        `abstract:${meta.isAbstract ? 1 : 0}`,
        `annotations:${annotations}`,
        `decl:${normalizeStructuralText(classInfo.classDeclaration.text)}`
    ];

    return normalizeStructuralText(parts.join('|'));
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

function extractNonMergeableHeaderFingerprint(parsed) {
    const outer = parsed.outerDeclaration;

    if (!outer || !outer.nonMergeableHeaderText) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Non-mergeable outer declaration header fingerprint is missing.'
        );
    }

    return normalizeStructuralText(outer.nonMergeableHeaderText);
}

function buildDeclarationInventory(parsed) {
    const outer = parsed.outerDeclaration;

    if (!outer) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Outer class declaration inventory is missing from parse result.'
        );
    }

    return {
        access: outer.access,
        sharing: outer.sharing,
        headerText: outer.headerText,
        headerRange: outer.headerRange,
        accessSourceRange: outer.accessSourceRange,
        sharingSourceRange: outer.sharingSourceRange,
        nonMergeableHeaderFingerprint: extractNonMergeableHeaderFingerprint(parsed)
    };
}

function declarationConflictKey(attribute) {
    return `declaration:${attribute}`;
}

function compareDeclarationAttribute({
    attribute,
    baseValue,
    sourceValue,
    destinationValue,
    baseAbsent
}) {
    const entry = {
        attribute,
        conflictKey: declarationConflictKey(attribute),
        baseValue: baseAbsent ? null : baseValue,
        sourceValue,
        destinationValue,
        selectedValue: null,
        status: DECLARATION_STATUS.CONFLICT
    };

    if (baseAbsent) {
        if (sourceValue === destinationValue) {
            entry.status = DECLARATION_STATUS.AUTO_RESOLVED;
            entry.selectedValue = sourceValue;
        }

        return entry;
    }

    if (sourceValue === destinationValue) {
        entry.status = DECLARATION_STATUS.AUTO_RESOLVED;
        entry.selectedValue = sourceValue;
        return entry;
    }

    if (sourceValue === baseValue) {
        entry.status = DECLARATION_STATUS.AUTO_RESOLVED;
        entry.selectedValue = destinationValue;
        return entry;
    }

    if (destinationValue === baseValue) {
        entry.status = DECLARATION_STATUS.AUTO_RESOLVED;
        entry.selectedValue = sourceValue;
        return entry;
    }

    return entry;
}

function mapDeclarationsForClient(declarations = {}) {
    const mapEntry = (entry) => {
        if (!entry) {
            return null;
        }

        return {
            attribute: entry.attribute,
            conflictKey: entry.conflictKey,
            baseValue: entry.baseValue,
            sourceValue: entry.sourceValue,
            destinationValue: entry.destinationValue,
            selectedValue: entry.selectedValue,
            status: entry.status,
            resolution: entry.resolution ?? null
        };
    };

    return {
        access: mapEntry(declarations.access),
        sharing: mapEntry(declarations.sharing)
    };
}

function countDeclarationConflicts(declarations = {}) {
    return [declarations.access, declarations.sharing].filter(
        (entry) => entry?.status === DECLARATION_STATUS.CONFLICT
    ).length;
}

function declarationValueForSide(inventories, attribute, side) {
    const branchInventory =
        side === DECLARATION_RESOLUTION_SIDE.SOURCE
            ? inventories?.source
            : inventories?.destination;

    if (!branchInventory) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_THREE_WAY_ARTIFACTS,
            `Missing declaration inventory for ${side}.`,
            { side, attribute }
        );
    }

    if (attribute === DECLARATION_ATTRIBUTE.ACCESS) {
        return branchInventory.access;
    }

    if (attribute === DECLARATION_ATTRIBUTE.SHARING) {
        return branchInventory.sharing;
    }

    throw new ApexMergeError(
        MERGE_ERROR.INVALID_REQUEST,
        `Unknown declaration attribute: ${attribute}.`,
        { attribute }
    );
}

function assertResolvableDeclarationKeys(declarations, declarationResolutions) {
    for (const resolution of declarationResolutions || []) {
        if (!KNOWN_DECLARATION_CONFLICT_KEYS.has(resolution.conflictKey)) {
            throw new ApexMergeError(
                MERGE_ERROR.UNKNOWN_DECLARATION_CONFLICT_KEY,
                `Unknown declaration conflictKey: ${resolution.conflictKey}.`,
                { conflictKey: resolution.conflictKey }
            );
        }

        const attribute =
            resolution.conflictKey === 'declaration:access'
                ? DECLARATION_ATTRIBUTE.ACCESS
                : DECLARATION_ATTRIBUTE.SHARING;
        const entry = declarations?.[attribute];

        if (!entry) {
            throw new ApexMergeError(
                MERGE_ERROR.UNKNOWN_DECLARATION_CONFLICT_KEY,
                `Declaration conflictKey is not part of the current comparison: ${resolution.conflictKey}.`,
                { conflictKey: resolution.conflictKey }
            );
        }
    }
}

function assertDeclarationResolutionTargetsAreConflicts(
    declarations,
    declarationResolutions
) {
    const byKey = new Map(
        [declarations?.access, declarations?.sharing]
            .filter(Boolean)
            .map((entry) => [entry.conflictKey, entry])
    );

    for (const resolution of declarationResolutions || []) {
        const entry = byKey.get(resolution.conflictKey);

        if (
            entry.status !== DECLARATION_STATUS.CONFLICT &&
            entry.status !== DECLARATION_STATUS.RESOLVED
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `Declaration ${resolution.conflictKey} is not in conflict and cannot be resolved.`,
                {
                    conflictKey: resolution.conflictKey,
                    status: entry.status
                }
            );
        }
    }
}

function resolveSelectedDeclarationValues(declarations) {
    const accessEntry = declarations?.access;
    const sharingEntry = declarations?.sharing;

    if (!accessEntry || !sharingEntry) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Declaration comparison is missing access or sharing entries.'
        );
    }

    const entries = [
        { attribute: DECLARATION_ATTRIBUTE.ACCESS, entry: accessEntry },
        { attribute: DECLARATION_ATTRIBUTE.SHARING, entry: sharingEntry }
    ];

    for (const { attribute, entry } of entries) {
        if (entry.status === DECLARATION_STATUS.CONFLICT) {
            throw new ApexMergeError(
                MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT,
                `Declaration attribute "${attribute}" is unresolved.`,
                { attribute, declarations }
            );
        }

        if (
            entry.status !== DECLARATION_STATUS.AUTO_RESOLVED &&
            entry.status !== DECLARATION_STATUS.RESOLVED
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Declaration attribute "${attribute}" has unsupported status "${entry.status}".`,
                { attribute, entry }
            );
        }

        if (entry.selectedValue == null && attribute === DECLARATION_ATTRIBUTE.ACCESS) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Declaration attribute "${attribute}" is missing selectedValue.`,
                { attribute, entry }
            );
        }

        if (entry.selectedValue == null && attribute === DECLARATION_ATTRIBUTE.SHARING) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Declaration attribute "${attribute}" is missing selectedValue.`,
                { attribute, entry }
            );
        }
    }

    const access = accessEntry.selectedValue;
    const sharing = sharingEntry.selectedValue;
    const allowedAccess = new Set([
        OUTER_ACCESS.PUBLIC,
        OUTER_ACCESS.GLOBAL,
        OUTER_ACCESS.UNSPECIFIED
    ]);

    if (!allowedAccess.has(access)) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            `Unsupported outer access selected for composition: ${access}`,
            { access, sharing }
        );
    }

    return { access, sharing };
}

function applyDeclarationResolutions(declarations, declarationResolutions, inventories) {
    if (!declarationResolutions?.length) {
        return;
    }

    const byKey = new Map();

    for (const resolution of declarationResolutions) {
        const side = String(resolution.side || '').toUpperCase();

        if (
            side !== DECLARATION_RESOLUTION_SIDE.SOURCE &&
            side !== DECLARATION_RESOLUTION_SIDE.DESTINATION
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_RESOLUTION_STRATEGY,
                `Unsupported declaration resolution side: ${resolution.side}`,
                { resolution }
            );
        }

        byKey.set(resolution.conflictKey, side);
    }

    for (const attribute of [
        DECLARATION_ATTRIBUTE.ACCESS,
        DECLARATION_ATTRIBUTE.SHARING
    ]) {
        const entry = declarations?.[attribute];

        if (!entry) {
            continue;
        }

        const side = byKey.get(entry.conflictKey);

        if (!side) {
            continue;
        }

        if (entry.status !== DECLARATION_STATUS.CONFLICT) {
            continue;
        }

        entry.resolution = side;
        entry.selectedValue = declarationValueForSide(inventories, attribute, side);
        entry.status = DECLARATION_STATUS.RESOLVED;
    }
}

function buildDeclarationComparison(baseParsed, sourceParsed, destinationParsed, baseAbsent) {
    const sourceInventory = buildDeclarationInventory(sourceParsed);
    const destinationInventory = buildDeclarationInventory(destinationParsed);
    const baseInventory = baseAbsent ? null : buildDeclarationInventory(baseParsed);

    const access = compareDeclarationAttribute({
        attribute: DECLARATION_ATTRIBUTE.ACCESS,
        baseValue: baseAbsent ? null : baseInventory.access,
        sourceValue: sourceInventory.access,
        destinationValue: destinationInventory.access,
        baseAbsent
    });

    const sharing = compareDeclarationAttribute({
        attribute: DECLARATION_ATTRIBUTE.SHARING,
        baseValue: baseAbsent ? null : baseInventory.sharing,
        sourceValue: sourceInventory.sharing,
        destinationValue: destinationInventory.sharing,
        baseAbsent
    });

    const declarations = {
        access,
        sharing
    };
    const declarationConflictCount = [access, sharing].filter(
        (item) => item.status === DECLARATION_STATUS.CONFLICT
    ).length;

    return {
        declarations,
        declarationConflictCount,
        inventories: {
            base: baseInventory,
            source: sourceInventory,
            destination: destinationInventory
        }
    };
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
        nonMergeableHeaderFingerprint: extractNonMergeableHeaderFingerprint(parsed),
        fields: root.fields
            .map((field) => normalizeStructuralText(field.sourceText))
            .sort(),
        properties: root.properties
            .map((property) => normalizeStructuralText(property.sourceText))
            .sort(),
        innerClasses: parsed.classes
            .filter((entry) => entry.parentQualifiedName === qn)
            .map((entry) => buildDirectNestedClassStructuralFingerprint(entry))
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

    const compareFields = [
        'nonMergeableHeaderFingerprint',
        'fields',
        'properties',
        'innerClasses'
    ];

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

    const compareFields = [
        'nonMergeableHeaderFingerprint',
        'fields',
        'properties',
        'innerClasses'
    ];

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
    const declarationComparison = buildDeclarationComparison(
        baseParsed,
        sourceParsed,
        destinationParsed,
        baseAbsent
    );

    return {
        mergeMode: METHOD_MERGE_MODE,
        className: sourceParsed.primaryClassName,
        methods,
        conflictCount,
        declarations: declarationComparison.declarations,
        declarationConflictCount: declarationComparison.declarationConflictCount,
        declarationInventories: declarationComparison.inventories,
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
    const unresolvedDeclarations = countDeclarationConflicts(comparison.declarations);

    if (unresolved > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `METHOD merge has ${unresolved} unresolved method conflict(s).`,
            { conflictCount: unresolved, methods: comparison.methods }
        );
    }

    if (unresolvedDeclarations > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT,
            `METHOD merge has ${unresolvedDeclarations} unresolved declaration conflict(s).`,
            {
                declarationConflictCount: unresolvedDeclarations,
                declarations: comparison.declarations
            }
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

    let composedSource = composeMethodMergedClass({
        sourceText: sourceContent,
        sourceParse: comparison.parses.source,
        selectedMethodTextByKey,
        removedMethodKeys,
        appendMethodTexts
    });

    const selectedDeclaration = resolveSelectedDeclarationValues(
        comparison.declarations
    );

    composedSource = applyOuterDeclarationToComposedClass(
        composedSource,
        selectedDeclaration
    );

    validateComposedDeclarationMerge({
        composedSource,
        sourceParse: comparison.parses.source,
        expectedClassName: comparison.className,
        selectedAccess: selectedDeclaration.access,
        selectedSharing: selectedDeclaration.sharing,
        expectedMethodKeys: expectedKeys
    });

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

    if (comparison.resolved && comparison.declarationConflictCount === 0) {
        composeApexMethodMerge(comparison, sourceContent);
    }

    return comparison;
}

module.exports = {
    METHOD_MERGE_MODE,
    METHOD_STATUS,
    METHOD_RESOLUTION_STRATEGY,
    DECLARATION_STATUS,
    DECLARATION_ATTRIBUTE,
    DECLARATION_RESOLUTION_SIDE,
    compareApexMethodMerge,
    applyMethodResolutions,
    applyDeclarationResolutions,
    resolveSelectedDeclarationValues,
    mapDeclarationsForClient,
    countDeclarationConflicts,
    assertResolvableDeclarationKeys,
    assertDeclarationResolutionTargetsAreConflicts,
    composeApexMethodMerge,
    executeApexMethodMerge,
    assertStructuralCompatibility,
    assertStructuralCompatibilityWithoutBase,
    isAbsentClassContent,
    buildMethodInventory,
    buildDeclarationInventory,
    buildDeclarationComparison,
    compareDeclarationAttribute,
    indexRootCallableMembers,
    collectStructuralSnapshot,
    buildDirectNestedClassStructuralFingerprint
};