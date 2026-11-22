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
const {
    composeMethodMergedClassRecursive,
    validateComposedRecursiveMethodMerge
} = require('./apexMergeMethodComposer.nested');

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
function buildClassInfoMap(parsed) {
    if (!parsed) {
        return new Map();
    }

    return new Map(parsed.classes.map((entry) => [entry.qualifiedName, entry]));
}

/**
 * Fields, properties, and child-class shells inside a nested class body (excludes member header).
 */
function buildNestedClassBodyStructuralFingerprint(classInfo, classByQualifiedName) {
    if (!classInfo) {
        return '';
    }

    const fields = (classInfo.fields || [])
        .map((field) => normalizeStructuralText(field.sourceText))
        .sort()
        .join('||');
    const properties = (classInfo.properties || [])
        .map((property) => normalizeStructuralText(property.sourceText))
        .sort()
        .join('||');
    const children = (classInfo.innerClasses || [])
        .map((child) => {
            const childInfo = classByQualifiedName.get(child.qualifiedName);

            return childInfo?.structuralShellFingerprint ?? child.qualifiedName;
        })
        .filter(Boolean)
        .sort()
        .join('||');

    return normalizeStructuralText(
        `fields:${fields}|properties:${properties}|children:${children}`
    );
}

function buildNestedFieldsPropertiesStructuralFingerprint(classInfo) {
    if (!classInfo) {
        return '';
    }

    const fields = (classInfo.fields || [])
        .map((field) => normalizeStructuralText(field.sourceText))
        .sort()
        .join('||');
    const properties = (classInfo.properties || [])
        .map((property) => normalizeStructuralText(property.sourceText))
        .sort()
        .join('||');

    return normalizeStructuralText(`fields:${fields}|properties:${properties}`);
}

function isNestedInventoryRetained(entry) {
    if (entry.status === METHOD_STATUS.CONFLICT) {
        return false;
    }

    if (entry.status === METHOD_STATUS.AUTO_EXCLUDED || entry.included === false) {
        return false;
    }

    return true;
}

function resolveExpectedNestedStructuralTemplates(entry, sourceMap, destMap) {
    if (entry.status === METHOD_STATUS.RESOLVED) {
        const chosenMap =
            entry.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? sourceMap
                : destMap;
        const chosenInfo = chosenMap.get(entry.qualifiedName);

        return {
            bodyTemplateInfo: chosenInfo,
            bodyTemplateMap: chosenMap,
            headerTemplateInfo: chosenInfo
        };
    }

    if (!entry.sourcePresent && entry.destinationPresent) {
        const destInfo = destMap.get(entry.qualifiedName);

        return {
            bodyTemplateInfo: destInfo,
            bodyTemplateMap: destMap,
            headerTemplateInfo: destInfo
        };
    }

    const sourceInfo = sourceMap.get(entry.qualifiedName);
    const headerInfo =
        entry.chosenFrom === 'destination'
            ? destMap.get(entry.qualifiedName) || sourceInfo
            : sourceInfo;

    return {
        bodyTemplateInfo: sourceInfo,
        bodyTemplateMap: sourceMap,
        headerTemplateInfo: headerInfo
    };
}

/**
 * Post-compose validation derived from inventory selections (not Source-only fingerprinting).
 */
function validateComposedNestedStructuralExpectations({
    parsed,
    nestedClasses,
    sourceParsed,
    destinationParsed,
    rootQualifiedName
}) {
    const sourceMap = buildClassInfoMap(sourceParsed);
    const destMap = buildClassInfoMap(destinationParsed);
    const composedMap = buildClassInfoMap(parsed);
    const retained = (nestedClasses || []).filter(isNestedInventoryRetained);

    for (const entry of retained) {
        const composedInfo = composedMap.get(entry.qualifiedName);

        if (!composedInfo) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Expected nested class missing from composed structure: ${entry.qualifiedName}.`,
                { qualifiedName: entry.qualifiedName }
            );
        }

        const templates = resolveExpectedNestedStructuralTemplates(
            entry,
            sourceMap,
            destMap
        );

        if (templates.bodyTemplateInfo) {
            const expectedFieldsProps =
                buildNestedFieldsPropertiesStructuralFingerprint(
                    templates.bodyTemplateInfo
                );
            const actualFieldsProps =
                buildNestedFieldsPropertiesStructuralFingerprint(composedInfo);

            if (
                normalizeStructuralText(expectedFieldsProps) !==
                normalizeStructuralText(actualFieldsProps)
            ) {
                throw new ApexMergeError(
                    MERGE_ERROR.METHOD_COMPOSE_FAILED,
                    `Composed nested class ${entry.qualifiedName} fields/properties do not match inventory expectation.`,
                    {
                        qualifiedName: entry.qualifiedName,
                        expectedFieldsProps,
                        actualFieldsProps
                    }
                );
            }
        }

        const expectedHeader = buildNestedClassHeaderStructuralFingerprint(
            templates.headerTemplateInfo
        );
        const actualHeader = buildNestedClassHeaderStructuralFingerprint(
            composedInfo
        );

        if (
            normalizeStructuralText(expectedHeader) !==
            normalizeStructuralText(actualHeader)
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Composed nested class ${entry.qualifiedName} header does not match inventory expectation.`,
                {
                    qualifiedName: entry.qualifiedName,
                    expectedHeader,
                    actualHeader
                }
            );
        }

        const expectedChildNames = retained
            .filter(
                (child) => child.parentQualifiedName === entry.qualifiedName
            )
            .map((child) => child.qualifiedName)
            .sort();
        const actualChildNames = (composedInfo.innerClasses || [])
            .map((child) => child.qualifiedName)
            .sort();

        if (
            JSON.stringify(expectedChildNames) !==
            JSON.stringify(actualChildNames)
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.METHOD_COMPOSE_FAILED,
                `Composed nested class ${entry.qualifiedName} child layout does not match inventory expectation.`,
                {
                    qualifiedName: entry.qualifiedName,
                    expectedChildNames,
                    actualChildNames
                }
            );
        }
    }

    const rootInfo =
        composedMap.get(rootQualifiedName) ||
        parsed.classes.find((entry) => entry.isRoot);
    const rootExpectedChildren = retained
        .filter((entry) => entry.parentQualifiedName === rootQualifiedName)
        .map((entry) => entry.qualifiedName)
        .sort();
    const rootActualChildren = (rootInfo?.innerClasses || [])
        .map((child) => child.qualifiedName)
        .sort();

    if (
        JSON.stringify(rootExpectedChildren) !==
        JSON.stringify(rootActualChildren)
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_COMPOSE_FAILED,
            'Composed root nested-class layout does not match inventory expectation.',
            { expectedChildNames: rootExpectedChildren, actualChildNames: rootActualChildren }
        );
    }
}

/**
 * Member-declaration modifiers and annotations for a nested class (header-only merge band).
 */
function buildNestedClassHeaderStructuralFingerprint(classInfo) {
    const meta = classInfo?.nestedMemberDeclaration;

    if (!meta || classInfo.isRoot) {
        return '';
    }

    const annotations = [...(meta.annotations || [])]
        .map((entry) => normalizeStructuralText(entry))
        .sort()
        .join(',');

    return normalizeStructuralText(
        [
            `access:${meta.accessModifier}`,
            `static:${meta.isStatic ? 1 : 0}`,
            `virtual:${meta.isVirtual ? 1 : 0}`,
            `abstract:${meta.isAbstract ? 1 : 0}`,
            `annotations:${annotations}`
        ].join('|')
    );
}

function nestedHeaderOnlyShellCompositionSupported(
    entry,
    baseParsed,
    sourceParsed,
    destinationParsed
) {
    if (entry.status !== METHOD_STATUS.AUTO_INCLUDED || !entry.chosenFrom) {
        return true;
    }

    if (!entry.sourcePresent || !entry.destinationPresent) {
        return true;
    }

    if (entry.sourceShell === entry.destinationShell) {
        return true;
    }

    const baseMap = buildClassInfoMap(baseParsed);
    const sourceMap = buildClassInfoMap(sourceParsed);
    const destMap = buildClassInfoMap(destinationParsed);
    const baseInfo = baseMap.get(entry.qualifiedName);
    const chosenInfo =
        entry.chosenFrom === 'destination'
            ? destMap.get(entry.qualifiedName)
            : sourceMap.get(entry.qualifiedName);
    const chosenSideMap =
        entry.chosenFrom === 'destination' ? destMap : sourceMap;

    if (!chosenInfo) {
        return false;
    }

    if (!baseInfo) {
        return true;
    }

    const bodyChosen = buildNestedClassBodyStructuralFingerprint(
        chosenInfo,
        chosenSideMap
    );
    const bodyBase = buildNestedClassBodyStructuralFingerprint(baseInfo, baseMap);

    return bodyChosen === bodyBase;
}

function enforceNestedStructuralCompositionSafety(
    nestedClasses,
    baseParsed,
    sourceParsed,
    destinationParsed
) {
    for (const entry of nestedClasses) {
        if (
            !nestedHeaderOnlyShellCompositionSupported(
                entry,
                baseParsed,
                sourceParsed,
                destinationParsed
            )
        ) {
            entry.status = METHOD_STATUS.CONFLICT;
            entry.chosenFrom = null;
            entry.included = true;
        }
    }
}

function deriveMethodMergeReadinessFields({
    conflictCount = 0,
    nestedClassConflictCount = 0,
    declarationConflictCount = 0,
    nestedClassComposeReady = false
} = {}) {
    const conflictsResolved =
        conflictCount === 0 &&
        nestedClassConflictCount === 0 &&
        declarationConflictCount === 0;
    const compositionReady =
        conflictsResolved && nestedClassComposeReady === true;

    return { conflictsResolved, compositionReady };
}

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

function buildScopedMethodKey(declaringClassQualifiedName, identityKey) {
    return `${declaringClassQualifiedName}#${identityKey}`;
}

function callableMembersForClass(parsed, declaringClassQualifiedName) {
    return parsed.methods.filter(
        (member) =>
            member.declaringClassQualifiedName === declaringClassQualifiedName &&
            (member.kind === 'method' || member.kind === 'constructor')
    );
}

function eligibleDeclaringClassesForMethodInventory(
    rootQualifiedName,
    nestedClasses = []
) {
    const eligible = new Set([rootQualifiedName]);

    for (const entry of nestedClasses) {
        if (
            entry.status === METHOD_STATUS.AUTO_INCLUDED ||
            entry.status === METHOD_STATUS.RESOLVED
        ) {
            eligible.add(entry.qualifiedName);
        }
    }

    return eligible;
}

function indexScopedCallableMembers(parsed, eligibleDeclaringClasses) {
    const map = new Map();

    for (const declaringClassQualifiedName of eligibleDeclaringClasses) {
        for (const member of callableMembersForClass(
            parsed,
            declaringClassQualifiedName
        )) {
            const scopedMethodKey = buildScopedMethodKey(
                member.declaringClassQualifiedName,
                member.identityKey
            );

            map.set(scopedMethodKey, member);
        }
    }

    return map;
}

function indexRootCallableMembers(parsed) {
    const rootName = parsed.primaryClassName;

    return indexScopedCallableMembers(
        parsed,
        eligibleDeclaringClassesForMethodInventory(rootName, [])
    );
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

    const compareFields = ['nonMergeableHeaderFingerprint', 'fields', 'properties'];

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
    const mismatches = listStructuralMismatches(source, dest).filter(
        (field) => field !== 'innerClasses'
    );

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

function memberBody(map, scopedMethodKey) {
    const member = map.get(scopedMethodKey);
    return member ? normalizeBodyText(member.sourceText) : null;
}

function sampleCallableMember(baseMap, sourceMap, destMap, scopedMethodKey) {
    return (
        sourceMap.get(scopedMethodKey) ||
        destMap.get(scopedMethodKey) ||
        baseMap.get(scopedMethodKey) ||
        null
    );
}

function buildMethodResolutionIndex(inventory, rootQualifiedName) {
    const byScoped = new Map();
    const rootByMethodKey = new Map();
    const nestedByMethodKey = new Map();

    for (const item of inventory) {
        byScoped.set(item.scopedMethodKey, item);

        if (item.declaringClassQualifiedName === rootQualifiedName) {
            rootByMethodKey.set(item.methodKey, item);
        } else if (item.methodKey) {
            if (!nestedByMethodKey.has(item.methodKey)) {
                nestedByMethodKey.set(item.methodKey, new Set());
            }

            nestedByMethodKey
                .get(item.methodKey)
                .add(item.declaringClassQualifiedName);
        }
    }

    return { byScoped, rootByMethodKey, nestedByMethodKey };
}

function resolveInventoryItemForMethodResolution(
    resolution,
    resolutionIndex,
    rootQualifiedName
) {
    if (resolution.scopedMethodKey) {
        return resolutionIndex.byScoped.get(resolution.scopedMethodKey) || null;
    }

    if (!resolution.methodKey) {
        return null;
    }

    if (resolution.declaringClassQualifiedName) {
        const scopedMethodKey = buildScopedMethodKey(
            resolution.declaringClassQualifiedName,
            resolution.methodKey
        );

        return resolutionIndex.byScoped.get(scopedMethodKey) || null;
    }

    const nestedOwners = resolutionIndex.nestedByMethodKey.get(
        resolution.methodKey
    );

    if (nestedOwners && nestedOwners.size > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            `Ambiguous methodKey ${resolution.methodKey}: specify declaringClassQualifiedName or scopedMethodKey for nested methods.`,
            { methodKey: resolution.methodKey, nestedOwners: [...nestedOwners] }
        );
    }

    return resolutionIndex.rootByMethodKey.get(resolution.methodKey) || null;
}

function methodResolutionStorageKey(resolution, rootQualifiedName) {
    if (resolution.scopedMethodKey) {
        return resolution.scopedMethodKey;
    }

    if (resolution.declaringClassQualifiedName && resolution.methodKey) {
        return buildScopedMethodKey(
            resolution.declaringClassQualifiedName,
            resolution.methodKey
        );
    }

    if (resolution.methodKey) {
        return buildScopedMethodKey(rootQualifiedName, resolution.methodKey);
    }

    return null;
}

function assertResolvableMethodResolutionKeys(
    inventory,
    methodResolutions,
    rootQualifiedName
) {
    const resolutionIndex = buildMethodResolutionIndex(
        inventory,
        rootQualifiedName
    );

    for (const resolution of methodResolutions || []) {
        const item = resolveInventoryItemForMethodResolution(
            resolution,
            resolutionIndex,
            rootQualifiedName
        );

        if (!item) {
            throw new ApexMergeError(
                MERGE_ERROR.UNKNOWN_METHOD_KEY,
                `Unknown method resolution target: ${JSON.stringify(resolution)}.`,
                { resolution }
            );
        }
    }
}

function assertMethodResolutionTargetsAreConflicts(
    inventory,
    methodResolutions,
    rootQualifiedName
) {
    const resolutionIndex = buildMethodResolutionIndex(
        inventory,
        rootQualifiedName
    );

    for (const resolution of methodResolutions || []) {
        const item = resolveInventoryItemForMethodResolution(
            resolution,
            resolutionIndex,
            rootQualifiedName
        );

        if (
            item.status !== METHOD_STATUS.CONFLICT &&
            item.status !== METHOD_STATUS.RESOLVED
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `Method ${item.scopedMethodKey} is not in conflict and cannot be resolved.`,
                {
                    scopedMethodKey: item.scopedMethodKey,
                    status: item.status
                }
            );
        }
    }
}

function findNestedClassInfo(parsed, qualifiedName) {
    if (!parsed) {
        return null;
    }

    return (
        parsed.classes.find(
            (entry) => entry.qualifiedName === qualifiedName && !entry.isRoot
        ) || null
    );
}

function collectNestedQualifiedNames(...parsedSides) {
    const names = new Set();

    for (const parsed of parsedSides) {
        if (!parsed) {
            continue;
        }

        for (const entry of parsed.classes) {
            if (!entry.isRoot) {
                names.add(entry.qualifiedName);
            }
        }
    }

    return [...names].sort();
}

function classifyNestedClassEntry({
    baseAbsent,
    basePresent,
    sourcePresent,
    destinationPresent,
    baseShell,
    sourceShell,
    destinationShell
}) {
    if (!baseAbsent && basePresent) {
        if (sourcePresent && destinationPresent) {
            if (sourceShell === destinationShell) {
                return {
                    status: METHOD_STATUS.AUTO_INCLUDED,
                    included: true,
                    chosenFrom: 'source'
                };
            }

            if (sourceShell === baseShell) {
                return {
                    status: METHOD_STATUS.AUTO_INCLUDED,
                    included: true,
                    chosenFrom: 'destination'
                };
            }

            if (destinationShell === baseShell) {
                return {
                    status: METHOD_STATUS.AUTO_INCLUDED,
                    included: true,
                    chosenFrom: 'source'
                };
            }

            return {
                status: METHOD_STATUS.CONFLICT,
                included: true,
                chosenFrom: null
            };
        }

        if (sourcePresent && !destinationPresent) {
            if (sourceShell === baseShell) {
                return {
                    status: METHOD_STATUS.AUTO_EXCLUDED,
                    included: false,
                    chosenFrom: null
                };
            }

            return {
                status: METHOD_STATUS.CONFLICT,
                included: true,
                chosenFrom: null
            };
        }

        if (!sourcePresent && destinationPresent) {
            if (destinationShell === baseShell) {
                return {
                    status: METHOD_STATUS.AUTO_EXCLUDED,
                    included: false,
                    chosenFrom: null
                };
            }

            return {
                status: METHOD_STATUS.CONFLICT,
                included: true,
                chosenFrom: null
            };
        }

        return {
            status: METHOD_STATUS.AUTO_EXCLUDED,
            included: false,
            chosenFrom: null
        };
    }

    if (sourcePresent && destinationPresent) {
        if (sourceShell === destinationShell) {
            return {
                status: METHOD_STATUS.AUTO_INCLUDED,
                included: true,
                chosenFrom: 'source'
            };
        }

        return {
            status: METHOD_STATUS.CONFLICT,
            included: true,
            chosenFrom: null
        };
    }

    if (sourcePresent) {
        return {
            status: METHOD_STATUS.AUTO_INCLUDED,
            included: true,
            chosenFrom: 'source'
        };
    }

    if (destinationPresent) {
        return {
            status: METHOD_STATUS.AUTO_INCLUDED,
            included: true,
            chosenFrom: 'destination'
        };
    }

    return {
        status: METHOD_STATUS.AUTO_EXCLUDED,
        included: false,
        chosenFrom: null
    };
}

/**
 * Three-way nested class inventory by qualified name (structural shell only).
 */
function buildNestedClassInventory(
    baseParsed,
    sourceParsed,
    destinationParsed,
    baseAbsent
) {
    const qualifiedNames = collectNestedQualifiedNames(
        baseAbsent ? null : baseParsed,
        sourceParsed,
        destinationParsed
    );
    const inventory = [];

    for (const qualifiedName of qualifiedNames) {
        const baseInfo = baseAbsent
            ? null
            : findNestedClassInfo(baseParsed, qualifiedName);
        const sourceInfo = findNestedClassInfo(sourceParsed, qualifiedName);
        const destinationInfo = findNestedClassInfo(
            destinationParsed,
            qualifiedName
        );
        const basePresent = Boolean(baseInfo);
        const sourcePresent = Boolean(sourceInfo);
        const destinationPresent = Boolean(destinationInfo);
        const baseShell = baseInfo?.structuralShellFingerprint ?? null;
        const sourceShell = sourceInfo?.structuralShellFingerprint ?? null;
        const destinationShell =
            destinationInfo?.structuralShellFingerprint ?? null;

        const classified = classifyNestedClassEntry({
            baseAbsent,
            basePresent,
            sourcePresent,
            destinationPresent,
            baseShell,
            sourceShell,
            destinationShell
        });

        const parentQualifiedName =
            sourceInfo?.parentQualifiedName ||
            destinationInfo?.parentQualifiedName ||
            baseInfo?.parentQualifiedName ||
            null;

        inventory.push({
            qualifiedName,
            parentQualifiedName,
            basePresent,
            sourcePresent,
            destinationPresent,
            baseShell,
            sourceShell,
            destinationShell,
            status: classified.status,
            resolution: null,
            included: classified.included,
            chosenFrom: classified.chosenFrom
        });
    }

    if (baseAbsent) {
        for (const entry of inventory) {
            if (
                entry.sourcePresent &&
                entry.destinationPresent &&
                entry.sourceShell !== entry.destinationShell
            ) {
                entry.status = METHOD_STATUS.CONFLICT;
                entry.included = true;
                entry.chosenFrom = null;
            }
        }
    }

    enforceNestedStructuralCompositionSafety(
        inventory,
        baseAbsent ? null : baseParsed,
        sourceParsed,
        destinationParsed
    );

    return inventory;
}

function countNestedClassConflicts(nestedClasses = []) {
    return nestedClasses.filter(
        (entry) => entry.status === METHOD_STATUS.CONFLICT
    ).length;
}

function buildNestedCallableBodyFingerprint(classInfo) {
    if (!classInfo) {
        return '';
    }

    return [...(classInfo.methods || []), ...(classInfo.constructors || [])]
        .map((member) => normalizeBodyText(member.sourceText))
        .sort()
        .join('||');
}

function chosenMethodImplementationText(item, sourceMap, destMap) {
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
        let text = primary.get(item.scopedMethodKey)?.sourceText;

        if (!text) {
            const secondary =
                item.chosenFrom === 'destination' ? sourceMap : destMap;

            text = secondary.get(item.scopedMethodKey)?.sourceText;
        }

        return text ?? null;
    }

    return null;
}

function isNestedClassEntryComposable(entry, sourceParsed, destinationParsed) {
    if (entry.status === METHOD_STATUS.CONFLICT) {
        return false;
    }

    if (entry.status === METHOD_STATUS.AUTO_EXCLUDED || !entry.included) {
        return true;
    }

    const srcInfo = findNestedClassInfo(sourceParsed, entry.qualifiedName);
    const dstInfo = findNestedClassInfo(
        destinationParsed,
        entry.qualifiedName
    );

    if (entry.status === METHOD_STATUS.RESOLVED) {
        const chosen =
            entry.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? srcInfo
                : dstInfo;

        return Boolean(chosen?.memberDeclarationRange);
    }

    if (!entry.sourcePresent && entry.destinationPresent) {
        return Boolean(dstInfo?.memberDeclarationRange);
    }

    if (entry.sourcePresent && !entry.destinationPresent) {
        return Boolean(srcInfo?.memberDeclarationRange);
    }

    if (entry.sourcePresent && entry.destinationPresent) {
        if (!srcInfo?.memberDeclarationRange) {
            return false;
        }

        if (
            entry.sourceShell !== entry.destinationShell &&
            entry.chosenFrom
        ) {
            const chosen =
                entry.chosenFrom === 'destination' ? dstInfo : srcInfo;

            if (!chosen?.memberDeclarationRange) {
                return false;
            }

            if (
                chosen.classBodyOpenBraceIndex == null ||
                srcInfo.classBodyOpenBraceIndex == null
            ) {
                return false;
            }
        }

        return true;
    }

    return false;
}

function isMethodInventoryItemComposable(item, sourceMap, destMap) {
    if (item.status === METHOD_STATUS.CONFLICT) {
        return false;
    }

    if (item.status === METHOD_STATUS.AUTO_EXCLUDED || !item.included) {
        return true;
    }

    const text = chosenMethodImplementationText(item, sourceMap, destMap);

    if (text) {
        return true;
    }

    if (!item.sourcePresent && item.destinationPresent) {
        return destMap.has(item.scopedMethodKey);
    }

    if (item.sourcePresent) {
        return sourceMap.has(item.scopedMethodKey);
    }

    return false;
}

function isNestedClassComposeReady(
    nestedClasses = [],
    sourceParsed = null,
    destinationParsed = null,
    methods = [],
    sourceMap = null,
    destMap = null
) {
    if (countNestedClassConflicts(nestedClasses) > 0) {
        return false;
    }

    if (countConflicts(methods) > 0) {
        return false;
    }

    for (const entry of nestedClasses) {
        if (!isNestedClassEntryComposable(entry, sourceParsed, destinationParsed)) {
            return false;
        }
    }

    if (sourceMap && destMap) {
        for (const item of methods || []) {
            if (!isMethodInventoryItemComposable(item, sourceMap, destMap)) {
                return false;
            }
        }
    }

    return true;
}

function applyNestedClassResolutions(nestedClasses, resolutions = []) {
    const byQualifiedName = new Map(
        nestedClasses.map((entry) => [entry.qualifiedName, entry])
    );

    for (const resolution of resolutions) {
        const item = byQualifiedName.get(resolution.qualifiedName);

        if (!item) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `Unknown nested class qualifiedName: ${resolution.qualifiedName}.`,
                { qualifiedName: resolution.qualifiedName }
            );
        }

        if (item.status !== METHOD_STATUS.CONFLICT) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `Nested class ${resolution.qualifiedName} is not in conflict and cannot be resolved.`,
                {
                    qualifiedName: resolution.qualifiedName,
                    status: item.status
                }
            );
        }

        if (
            resolution.strategy !== METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE &&
            resolution.strategy !== METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_RESOLUTION_STRATEGY,
                `Unsupported nested class resolution strategy: ${resolution.strategy}`,
                { resolution }
            );
        }

        item.resolution = resolution.strategy;
        item.status = METHOD_STATUS.RESOLVED;
        item.chosenFrom =
            resolution.strategy === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? 'source'
                : 'destination';
        item.included = true;
    }
}

function assertResolvableNestedClassKeys(nestedClasses, nestedClassResolutions) {
    const knownKeys = new Set(
        nestedClasses.map((entry) => entry.qualifiedName)
    );

    for (const resolution of nestedClassResolutions || []) {
        if (!knownKeys.has(resolution.qualifiedName)) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `Unknown nested class qualifiedName: ${resolution.qualifiedName}.`,
                { qualifiedName: resolution.qualifiedName }
            );
        }
    }
}

function assertNestedClassResolutionTargetsAreConflicts(
    nestedClasses,
    nestedClassResolutions
) {
    const byKey = new Map(
        nestedClasses.map((entry) => [entry.qualifiedName, entry])
    );

    for (const resolution of nestedClassResolutions || []) {
        const item = byKey.get(resolution.qualifiedName);

        if (
            item.status !== METHOD_STATUS.CONFLICT &&
            item.status !== METHOD_STATUS.RESOLVED
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `Nested class ${resolution.qualifiedName} is not in conflict and cannot be resolved.`,
                {
                    qualifiedName: resolution.qualifiedName,
                    status: item.status
                }
            );
        }
    }
}

function mapNestedClassesForClient(nestedClasses = []) {
    return nestedClasses.map((entry) => ({
        qualifiedName: entry.qualifiedName,
        parentQualifiedName: entry.parentQualifiedName,
        basePresent: entry.basePresent,
        sourcePresent: entry.sourcePresent,
        destinationPresent: entry.destinationPresent,
        status: entry.status,
        resolution: entry.resolution ?? null,
        included: entry.included !== false,
        structuralShell: {
            base: entry.baseShell,
            source: entry.sourceShell,
            destination: entry.destinationShell
        }
    }));
}

function chooseTextFromMap(map, key) {
    const member = map.get(key);
    return member ? member.sourceText : null;
}

/**
 * Three-way callable-member comparison (root and eligible nested classes).
 */
function buildMethodInventory(
    baseMap,
    sourceMap,
    destMap,
    rootQualifiedName = null
) {
    const keys = new Set([
        ...baseMap.keys(),
        ...sourceMap.keys(),
        ...destMap.keys()
    ]);
    const inventory = [];

    for (const scopedMethodKey of [...keys].sort()) {
        const basePresent = baseMap.has(scopedMethodKey);
        const sourcePresent = sourceMap.has(scopedMethodKey);
        const destinationPresent = destMap.has(scopedMethodKey);

        const baseBody = memberBody(baseMap, scopedMethodKey);
        const sourceBody = memberBody(sourceMap, scopedMethodKey);
        const destinationBody = memberBody(destMap, scopedMethodKey);

        const sampleMember = sampleCallableMember(
            baseMap,
            sourceMap,
            destMap,
            scopedMethodKey
        );
        const methodKey =
            sampleMember?.identityKey ??
            scopedMethodKey.split('#').slice(1).join('#');
        const declaringClassQualifiedName =
            sampleMember?.declaringClassQualifiedName ??
            scopedMethodKey.split('#')[0];

        const entry = {
            methodKey,
            declaringClassQualifiedName,
            scopedMethodKey,
            isRootCallable:
                rootQualifiedName != null &&
                declaringClassQualifiedName === rootQualifiedName,
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
                    entry.chosenImplementation = chooseTextFromMap(
                        sourceMap,
                        scopedMethodKey
                    );
                    entry.chosenFrom = 'source';
                } else if (sourceBody !== baseBody && destinationBody === baseBody) {
                    entry.chosenImplementation = chooseTextFromMap(
                        sourceMap,
                        scopedMethodKey
                    );
                    entry.chosenFrom = 'source';
                } else if (destinationBody !== baseBody && sourceBody === baseBody) {
                    entry.chosenImplementation = chooseTextFromMap(
                        destMap,
                        scopedMethodKey
                    );
                    entry.chosenFrom = 'destination';
                } else if (
                    sourceBody !== baseBody &&
                    destinationBody !== baseBody &&
                    sourceBody === destinationBody
                ) {
                    entry.chosenImplementation = chooseTextFromMap(
                        sourceMap,
                        scopedMethodKey
                    );
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
                if (sourceBody === baseBody) {
                    entry.status = METHOD_STATUS.AUTO_EXCLUDED;
                    entry.included = false;
                    entry.chosenImplementation = null;
                    entry.chosenFrom = 'destination';
                } else {
                    entry.status = METHOD_STATUS.CONFLICT;
                    entry.included = true;
                }
            } else if (!sourcePresent && destinationPresent) {
                if (destinationBody === baseBody) {
                    entry.status = METHOD_STATUS.AUTO_EXCLUDED;
                    entry.included = false;
                    entry.chosenImplementation = null;
                    entry.chosenFrom = 'source';
                } else {
                    entry.status = METHOD_STATUS.CONFLICT;
                    entry.included = true;
                }
            } else {
                entry.status = METHOD_STATUS.AUTO_EXCLUDED;
                entry.included = false;
                entry.chosenImplementation = null;
            }
        } else if (sourcePresent && destinationPresent) {
            if (sourceBody === destinationBody) {
                entry.chosenImplementation = chooseTextFromMap(
                    sourceMap,
                    scopedMethodKey
                );
                entry.chosenFrom = 'source';
            } else {
                entry.status = METHOD_STATUS.CONFLICT;
            }
        } else if (sourcePresent) {
            entry.chosenImplementation = chooseTextFromMap(
                sourceMap,
                scopedMethodKey
            );
            entry.chosenFrom = 'source';
        } else if (destinationPresent) {
            entry.chosenImplementation = chooseTextFromMap(
                destMap,
                scopedMethodKey
            );
            entry.chosenFrom = 'destination';
        }

        inventory.push(entry);
    }

    return inventory;
}

function countConflicts(inventory) {
    return inventory.filter((item) => item.status === METHOD_STATUS.CONFLICT).length;
}

function applyMethodResolutions(
    inventory,
    resolutions,
    sourceMap,
    destMap,
    rootQualifiedName
) {
    if (!resolutions || !resolutions.length) {
        return;
    }

    const resolutionIndex = buildMethodResolutionIndex(
        inventory,
        rootQualifiedName
    );
    const strategyByScoped = new Map();

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

        const item = resolveInventoryItemForMethodResolution(
            resolution,
            resolutionIndex,
            rootQualifiedName
        );

        if (!item) {
            throw new ApexMergeError(
                MERGE_ERROR.UNKNOWN_METHOD_KEY,
                `Unknown method resolution target: ${JSON.stringify(resolution)}.`,
                { resolution }
            );
        }

        strategyByScoped.set(item.scopedMethodKey, resolution.strategy);
    }

    for (const item of inventory) {
        if (item.status !== METHOD_STATUS.CONFLICT) {
            continue;
        }

        const strategy = strategyByScoped.get(item.scopedMethodKey);

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

        if (sideMap.has(item.scopedMethodKey)) {
            item.chosenImplementation = chooseTextFromMap(
                sideMap,
                item.scopedMethodKey
            );
            item.included = true;
        } else {
            item.chosenImplementation = null;
            item.included = false;
        }
    }
}

function buildSelectionMaps(inventory, sourceMap, destMap, rootQualifiedName) {
    const selectedMethodTextByKey = new Map();
    const removedMethodKeys = new Set();
    const appendMethodTexts = [];
    const expectedKeys = new Set();

    for (const item of inventory) {
        if (item.declaringClassQualifiedName !== rootQualifiedName) {
            continue;
        }

        if (item.status === METHOD_STATUS.AUTO_EXCLUDED) {
            continue;
        }

        if (item.status === METHOD_STATUS.CONFLICT) {
            continue;
        }

        if (!item.included) {
            if (sourceMap.has(item.scopedMethodKey)) {
                removedMethodKeys.add(item.methodKey);
            }
            continue;
        }

        const text =
            item.chosenImplementation ||
            (item.status === METHOD_STATUS.RESOLVED &&
            item.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                ? chooseTextFromMap(sourceMap, item.scopedMethodKey)
                : item.status === METHOD_STATUS.RESOLVED &&
                  item.resolution === METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                ? chooseTextFromMap(destMap, item.scopedMethodKey)
                : null);

        if (!text) {
            continue;
        }

        expectedKeys.add(item.methodKey);

        if (sourceMap.has(item.scopedMethodKey)) {
            const sourceSlice = chooseTextFromMap(
                sourceMap,
                item.scopedMethodKey
            );

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

    const rootQualifiedName = sourceParsed.primaryClassName;
    let baseParsed = null;
    let baseMap = new Map();

    if (baseAbsent) {
        assertStructuralCompatibilityWithoutBase(sourceParsed, destinationParsed);
    } else {
        baseParsed = parseSide('base', baseContent);
        assertStructuralCompatibility(baseParsed, sourceParsed, destinationParsed);
    }

    const nestedClasses = buildNestedClassInventory(
        baseParsed,
        sourceParsed,
        destinationParsed,
        baseAbsent
    );
    const eligibleDeclaringClasses = eligibleDeclaringClassesForMethodInventory(
        rootQualifiedName,
        nestedClasses
    );

    if (baseAbsent) {
        baseMap = new Map();
    } else {
        baseMap = indexScopedCallableMembers(baseParsed, eligibleDeclaringClasses);
    }

    const sourceMap = indexScopedCallableMembers(
        sourceParsed,
        eligibleDeclaringClasses
    );
    const destMap = indexScopedCallableMembers(
        destinationParsed,
        eligibleDeclaringClasses
    );
    const nestedClassConflictCount = countNestedClassConflicts(nestedClasses);
    const methods = buildMethodInventory(
        baseMap,
        sourceMap,
        destMap,
        rootQualifiedName
    );
    const nestedClassComposeReady = isNestedClassComposeReady(
        nestedClasses,
        sourceParsed,
        destinationParsed,
        methods,
        sourceMap,
        destMap
    );
    const conflictCount = countConflicts(methods);
    const declarationComparison = buildDeclarationComparison(
        baseParsed,
        sourceParsed,
        destinationParsed,
        baseAbsent
    );
    const declarationConflictCount =
        declarationComparison.declarationConflictCount;
    const readiness = deriveMethodMergeReadinessFields({
        conflictCount,
        nestedClassConflictCount,
        declarationConflictCount,
        nestedClassComposeReady
    });

    return {
        mergeMode: METHOD_MERGE_MODE,
        className: sourceParsed.primaryClassName,
        methods,
        nestedClasses,
        nestedClassConflictCount,
        nestedClassComposeReady,
        conflictCount,
        declarations: declarationComparison.declarations,
        declarationConflictCount,
        declarationInventories: declarationComparison.inventories,
        resolved: readiness.conflictsResolved,
        compositionReady: readiness.compositionReady,
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
function composeApexMethodMerge(
    comparison,
    sourceContent,
    destinationContent = null
) {
    const unresolvedNested = countNestedClassConflicts(
        comparison.nestedClasses || []
    );

    if (unresolvedNested > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `METHOD merge has ${unresolvedNested} unresolved nested class conflict(s).`,
            {
                nestedClassConflictCount: unresolvedNested,
                nestedClasses: comparison.nestedClasses
            }
        );
    }

    const unresolved = countConflicts(comparison.methods);

    if (unresolved > 0) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `METHOD merge has ${unresolved} unresolved method conflict(s).`,
            { conflictCount: unresolved, methods: comparison.methods }
        );
    }

    const unresolvedDeclarations = countDeclarationConflicts(
        comparison.declarations
    );

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

    comparison.nestedClassComposeReady = isNestedClassComposeReady(
        comparison.nestedClasses,
        comparison.parses?.source,
        comparison.parses?.destination,
        comparison.methods,
        comparison.maps?.source,
        comparison.maps?.destination
    );

    if (comparison.nestedClassComposeReady !== true) {
        throw new ApexMergeError(
            MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
            `METHOD merge is not ready to compose: unresolved nested class or method conflicts remain.`,
            {
                nestedClassComposeReady: comparison.nestedClassComposeReady,
                nestedClasses: comparison.nestedClasses,
                conflictCount: unresolved
            }
        );
    }

    const destinationText =
        destinationContent ??
        comparison.parses?.destination?.__sourceText ??
        sourceContent;
    const destinationParse =
        comparison.parses?.destination ?? comparison.parses?.source;

    const composition = composeMethodMergedClassRecursive({
        sourceText: sourceContent,
        destinationText: destinationText,
        sourceParse: comparison.parses.source,
        destinationParse,
        methods: comparison.methods,
        nestedClasses: comparison.nestedClasses || [],
        sourceMap: comparison.maps.source,
        destMap: comparison.maps.destination,
        rootQualifiedName: comparison.className
    });

    let composedSource = composition.composedSource;

    const selectedDeclaration = resolveSelectedDeclarationValues(
        comparison.declarations
    );

    composedSource = applyOuterDeclarationToComposedClass(
        composedSource,
        selectedDeclaration
    );

    const hasNestedComposition =
        (comparison.nestedClasses || []).length > 0 ||
        (comparison.methods || []).some(
            (entry) => entry.declaringClassQualifiedName !== comparison.className
        );

    const parsedComposed = validateComposedRecursiveMethodMerge({
        composedSource,
        expectedRootMethodKeys: composition.expectedRootMethodKeys,
        expectedScopedMethodKeys: composition.expectedScopedMethodKeys,
        excludedScopedMethodKeys: composition.excludedScopedMethodKeys,
        retainedNestedQualifiedNames: composition.retainedNestedQualifiedNames,
        excludedNestedQualifiedNames: composition.excludedNestedQualifiedNames,
        rootQualifiedName: comparison.className
    });

    validateComposedNestedStructuralExpectations({
        parsed: parsedComposed,
        nestedClasses: comparison.nestedClasses || [],
        sourceParsed: comparison.parses.source,
        destinationParsed: destinationParse,
        rootQualifiedName: comparison.className
    });

    validateComposedDeclarationMerge({
        composedSource,
        sourceParse: comparison.parses.source,
        expectedClassName: comparison.className,
        selectedAccess: selectedDeclaration.access,
        selectedSharing: selectedDeclaration.sharing,
        expectedMethodKeys: composition.expectedRootMethodKeys,
        skipInnerClassStructuralSnapshot: hasNestedComposition
    });

    comparison.composedSource = composedSource;
    comparison.composeSuccess = true;
    comparison.nestedClassComposeReady = true;
    comparison.resolved = true;
    comparison.compositionReady = true;

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
            comparison.maps.destination,
            comparison.className
        );

        const remaining = countConflicts(comparison.methods);

        comparison.conflictCount = remaining;
        comparison.nestedClassComposeReady = isNestedClassComposeReady(
            comparison.nestedClasses,
            comparison.parses.source,
            comparison.parses.destination,
            comparison.methods,
            comparison.maps.source,
            comparison.maps.destination
        );
        const readiness = deriveMethodMergeReadinessFields({
            conflictCount: remaining,
            nestedClassConflictCount: comparison.nestedClassConflictCount,
            declarationConflictCount: comparison.declarationConflictCount,
            nestedClassComposeReady: comparison.nestedClassComposeReady
        });
        comparison.resolved = readiness.conflictsResolved;
        comparison.compositionReady = readiness.compositionReady;
    }

    const compositionReady =
        comparison.compositionReady === true ||
        deriveMethodMergeReadinessFields({
            conflictCount: comparison.conflictCount,
            nestedClassConflictCount: comparison.nestedClassConflictCount,
            declarationConflictCount: comparison.declarationConflictCount,
            nestedClassComposeReady: comparison.nestedClassComposeReady
        }).compositionReady;

    if (compositionReady) {
        composeApexMethodMerge(
            comparison,
            sourceContent,
            destinationContent
        );
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
    buildScopedMethodKey,
    eligibleDeclaringClassesForMethodInventory,
    indexScopedCallableMembers,
    assertResolvableMethodResolutionKeys,
    assertMethodResolutionTargetsAreConflicts,
    methodResolutionStorageKey,
    buildNestedClassInventory,
    applyNestedClassResolutions,
    assertResolvableNestedClassKeys,
    assertNestedClassResolutionTargetsAreConflicts,
    mapNestedClassesForClient,
    countNestedClassConflicts,
    isNestedClassComposeReady,
    deriveMethodMergeReadinessFields,
    buildNestedClassBodyStructuralFingerprint,
    buildNestedClassHeaderStructuralFingerprint,
    validateComposedNestedStructuralExpectations,
    nestedHeaderOnlyShellCompositionSupported,
    buildDeclarationInventory,
    buildDeclarationComparison,
    compareDeclarationAttribute,
    indexRootCallableMembers,
    collectStructuralSnapshot,
    buildDirectNestedClassStructuralFingerprint
};