'use strict';

const {
    ApexParserFactory,
    ApexParserBaseListener,
    ApexParseTreeWalker,
} = require('@apexdevtools/apex-parser');
const { ApexErrorListener } = require('@apexdevtools/apex-parser');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');

/**
 * Collect lexer and parser syntax errors (no silent fallback).
 */
class CollectingApexErrorListener extends ApexErrorListener {
    constructor() {
        super();
        this.errors = [];
    }

    apexSyntaxError(line, column, msg) {
        this.errors.push({ line, column, message: msg });
    }
}

function extractSourceRange(ctx, source) {
    if (!ctx || !ctx.start) {
        return {
            text: '',
            start: 0,
            end: 0,
            startLine: 1,
            startColumn: 0,
            endLine: 1,
            endColumn: 0
        };
    }

    const startIdx = ctx.start.start;
    const stopIdx = ctx.stop ? ctx.stop.stop : ctx.start.stop;
    const text = source.slice(startIdx, stopIdx + 1);

    return {
        text,
        start: startIdx,
        end: stopIdx + 1,
        startLine: ctx.start.line,
        startColumn: ctx.start.column,
        endLine: ctx.stop ? ctx.stop.line : ctx.start.line,
        endColumn: ctx.stop ? ctx.stop.column : ctx.start.column
    };
}

function sliceNodeText(node, source) {
    if (!node) {
        return '';
    }

    return extractSourceRange(node, source).text.trim();
}

function normalizeTypeText(typeText) {
    return String(typeText || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeParameterTypeForIdentity(typeText) {
    return normalizeTypeText(typeText).replace(/,\s+/g, ',');
}

function buildMethodIdentityKey(methodName, parameterTypes) {
    const types = (parameterTypes || []).map(normalizeParameterTypeForIdentity);
    return `${methodName}(${types.join(',')})`;
}

const OUTER_ACCESS = Object.freeze({
    PUBLIC: 'public',
    GLOBAL: 'global',
    PROTECTED: 'protected',
    PRIVATE: 'private',
    UNSPECIFIED: 'unspecified'
});

const OUTER_SHARING = Object.freeze({
    WITH: 'with',
    WITHOUT: 'without',
    INHERITED: 'inherited',
    OMITTED: 'omitted'
});

/**
 * Root class body opening `{` from classBody().LBRACE() on the root classDeclaration ctx.
 *
 * @param {object} classDeclarationCtx ANTLR classDeclaration context (root only)
 * @returns {number|null}
 */
function resolveRootClassBodyOpenBraceIndex(classDeclarationCtx) {
    if (!classDeclarationCtx?.classBody) {
        return null;
    }

    const bodyCtx = classDeclarationCtx.classBody();

    if (!bodyCtx?.LBRACE) {
        return null;
    }

    const braceNode = bodyCtx.LBRACE();

    if (braceNode?.symbol?.start == null) {
        return null;
    }

    return braceNode.symbol.start;
}

function findRootClassBodyBraceIndex(sourceText, classDeclarationStart) {
    const startIndex = Math.max(0, Number(classDeclarationStart) || 0);

    for (let index = startIndex; index < sourceText.length; index += 1) {
        if (sourceText[index] === '{') {
            return index;
        }
    }

    return -1;
}

function applyTextOperations(text, operations) {
    const sorted = [...operations].sort((left, right) => right.start - left.start);
    let result = String(text);

    for (const operation of sorted) {
        result =
            result.slice(0, operation.start) +
            operation.text +
            result.slice(operation.end);
    }

    return result;
}

/**
 * ANTLR token stop index is inclusive; JavaScript slice end is exclusive (stop + 1).
 */
function terminalTokenSpan(terminalNode) {
    if (!terminalNode?.symbol) {
        return null;
    }

    const { start, stop } = terminalNode.symbol;

    return {
        start,
        end: stop + 1,
        text: terminalNode.getText()
    };
}

function sharingQualifierTokenText(sharing) {
    if (sharing === OUTER_SHARING.WITH) {
        return 'with';
    }

    if (sharing === OUTER_SHARING.WITHOUT) {
        return 'without';
    }

    if (sharing === OUTER_SHARING.INHERITED) {
        return 'inherited';
    }

    return null;
}

/**
 * Read root type modifiers from typeDeclaration().modifier_list().
 *
 * @param {object|null} typeDeclarationCtx
 * @returns {object}
 */
function collectRootOuterDeclarationModifiers(typeDeclarationCtx) {
    if (!typeDeclarationCtx?.modifier_list) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Root typeDeclaration modifier_list is missing.'
        );
    }

    const modifiers = typeDeclarationCtx.modifier_list() || [];
    let accessToken = null;
    let sharingQualifierToken = null;
    let sharingKeywordToken = null;

    for (const modifierCtx of modifiers) {
        const annotationCtx = modifierCtx.annotation
            ? modifierCtx.annotation()
            : null;

        if (annotationCtx) {
            continue;
        }

        const globalNode = modifierCtx.GLOBAL ? modifierCtx.GLOBAL() : null;
        const publicNode = modifierCtx.PUBLIC ? modifierCtx.PUBLIC() : null;
        const protectedNode = modifierCtx.PROTECTED ? modifierCtx.PROTECTED() : null;
        const privateNode = modifierCtx.PRIVATE ? modifierCtx.PRIVATE() : null;
        const inheritedNode = modifierCtx.INHERITED ? modifierCtx.INHERITED() : null;
        const withoutNode = modifierCtx.WITHOUT ? modifierCtx.WITHOUT() : null;
        const withNode = modifierCtx.WITH ? modifierCtx.WITH() : null;
        const sharingNode = modifierCtx.SHARING ? modifierCtx.SHARING() : null;

        if (globalNode) {
            if (accessToken) {
                throw new ApexMergeError(
                    MERGE_ERROR.PARSE_FAILED,
                    'Ambiguous outer class access modifiers in modifier_list.'
                );
            }

            accessToken = {
                value: OUTER_ACCESS.GLOBAL,
                ...terminalTokenSpan(globalNode)
            };
        }

        if (publicNode) {
            if (accessToken) {
                throw new ApexMergeError(
                    MERGE_ERROR.PARSE_FAILED,
                    'Ambiguous outer class access modifiers in modifier_list.'
                );
            }

            accessToken = {
                value: OUTER_ACCESS.PUBLIC,
                ...terminalTokenSpan(publicNode)
            };
        }

        if (protectedNode) {
            if (accessToken) {
                throw new ApexMergeError(
                    MERGE_ERROR.PARSE_FAILED,
                    'Ambiguous outer class access modifiers in modifier_list.'
                );
            }

            accessToken = {
                value: OUTER_ACCESS.PROTECTED,
                ...terminalTokenSpan(protectedNode)
            };
        }

        if (privateNode) {
            if (accessToken) {
                throw new ApexMergeError(
                    MERGE_ERROR.PARSE_FAILED,
                    'Ambiguous outer class access modifiers in modifier_list.'
                );
            }

            accessToken = {
                value: OUTER_ACCESS.PRIVATE,
                ...terminalTokenSpan(privateNode)
            };
        }

        const qualifierNodes = [
            inheritedNode,
            withoutNode,
            withNode
        ].filter(Boolean);

        if (qualifierNodes.length > 1) {
            throw new ApexMergeError(
                MERGE_ERROR.PARSE_FAILED,
                'Ambiguous sharing qualifier modifiers in modifier_list.'
            );
        }

        if (qualifierNodes.length || sharingNode) {
            if (sharingQualifierToken || sharingKeywordToken) {
                throw new ApexMergeError(
                    MERGE_ERROR.PARSE_FAILED,
                    'Duplicate sharing modifier groups in modifier_list.'
                );
            }

            if (sharingNode && !qualifierNodes.length) {
                throw new ApexMergeError(
                    MERGE_ERROR.PARSE_FAILED,
                    'Malformed sharing declaration: sharing without qualifier.'
                );
            }

            if (qualifierNodes.length && !sharingNode) {
                throw new ApexMergeError(
                    MERGE_ERROR.PARSE_FAILED,
                    'Malformed sharing declaration: qualifier without sharing.'
                );
            }

            const qualifierNode = qualifierNodes[0];
            let sharingValue = OUTER_SHARING.OMITTED;

            if (inheritedNode) {
                sharingValue = OUTER_SHARING.INHERITED;
            } else if (withoutNode) {
                sharingValue = OUTER_SHARING.WITHOUT;
            } else if (withNode) {
                sharingValue = OUTER_SHARING.WITH;
            }

            sharingQualifierToken = {
                value: sharingValue,
                ...terminalTokenSpan(qualifierNode)
            };
            sharingKeywordToken = terminalTokenSpan(sharingNode);
        }
    }

    const sharing = sharingQualifierToken
        ? sharingQualifierToken.value
        : OUTER_SHARING.OMITTED;

    return {
        access: accessToken,
        sharingQualifier: sharingQualifierToken,
        sharingKeyword: sharingKeywordToken,
        sharing
    };
}

function resolveMergeableModifierInsertIndex(outer, modifiers) {
    if (modifiers?.sharingQualifier) {
        return modifiers.sharingQualifier.start;
    }

    return outer.classClauseRange.start;
}

function resolveSharingInsertIndex(outer, modifiers, selection) {
    if (modifiers?.sharingQualifier) {
        return modifiers.sharingQualifier.start;
    }

    if (modifiers?.access) {
        if (
            selection.access !== OUTER_ACCESS.UNSPECIFIED &&
            selection.access !== modifiers.access.value
        ) {
            return modifiers.access.start + selection.access.length;
        }

        return modifiers.access.end;
    }

    if (selection.access !== OUTER_ACCESS.UNSPECIFIED) {
        const base = resolveMergeableModifierInsertIndex(outer, modifiers);
        return base + selection.access.length + 1;
    }

    return resolveMergeableModifierInsertIndex(outer, modifiers);
}

function buildMergeableModifierInsertText(selection) {
    const parts = [];

    if (selection.access !== OUTER_ACCESS.UNSPECIFIED) {
        parts.push(selection.access);
    }

    const sharingQualifier = sharingQualifierTokenText(selection.sharing);

    if (sharingQualifier) {
        parts.push(sharingQualifier, 'sharing');
    }

    if (!parts.length) {
        return '';
    }

    return `${parts.join(' ')} `;
}

function buildOuterDeclarationReplacementOperations(outer, selection) {
    const modifiers = outer.modifierTokens;

    if (!modifiers) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Root outer declaration modifier tokens are missing.'
        );
    }

    const operations = [];
    const targetQualifier = sharingQualifierTokenText(selection.sharing);
    const currentAccess = modifiers.access
        ? modifiers.access.value
        : OUTER_ACCESS.UNSPECIFIED;
    const targetAccess = selection.access;

    if (targetAccess === OUTER_ACCESS.UNSPECIFIED) {
        if (modifiers.access) {
            operations.push({
                start: modifiers.access.start,
                end: modifiers.access.end,
                text: ''
            });
        }
    } else if (modifiers.access) {
        if (targetAccess !== modifiers.access.value) {
            operations.push({
                start: modifiers.access.start,
                end: modifiers.access.end,
                text: targetAccess
            });
        }
    } else {
        const insertAt = resolveMergeableModifierInsertIndex(outer, modifiers);
        const needsSharingInsert =
            targetQualifier && !modifiers.sharingQualifier;

        if (needsSharingInsert) {
            operations.push({
                start: insertAt,
                end: insertAt,
                text: buildMergeableModifierInsertText(selection)
            });
        } else {
            operations.push({
                start: insertAt,
                end: insertAt,
                text: `${targetAccess} `
            });
        }
    }

    if (modifiers.sharingQualifier && targetQualifier) {
        if (targetQualifier !== modifiers.sharingQualifier.text) {
            operations.push({
                start: modifiers.sharingQualifier.start,
                end: modifiers.sharingQualifier.end,
                text: targetQualifier
            });
        }
    } else if (modifiers.sharingQualifier && !targetQualifier) {
        if (modifiers.sharingKeyword) {
            operations.push({
                start: modifiers.sharingKeyword.start,
                end: modifiers.sharingKeyword.end,
                text: ''
            });
        }

        operations.push({
            start: modifiers.sharingQualifier.start,
            end: modifiers.sharingQualifier.end,
            text: ''
        });
    } else if (
        !modifiers.sharingQualifier &&
        targetQualifier &&
        !(targetAccess !== OUTER_ACCESS.UNSPECIFIED && !modifiers.access)
    ) {
        if (!modifiers.sharingKeyword) {
            const insertAt = resolveSharingInsertIndex(outer, modifiers, selection);
            operations.push({
                start: insertAt,
                end: insertAt,
                text: ` ${targetQualifier} sharing`
            });
        }
    } else if (
        modifiers.sharingQualifier &&
        targetQualifier &&
        !modifiers.sharingKeyword
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Sharing modifier state is inconsistent.'
        );
    }

    return operations;
}

function rangeSlice(sourceText, range) {
    if (!range) {
        return '';
    }

    return sourceText.slice(range.start, range.end);
}

function collectMergeableOuterModifierRanges(modifierTokens) {
    const ranges = [];

    if (modifierTokens?.access) {
        ranges.push({
            start: modifierTokens.access.start,
            end: modifierTokens.access.end
        });
    }

    if (modifierTokens?.sharingQualifier) {
        ranges.push({
            start: modifierTokens.sharingQualifier.start,
            end: modifierTokens.sharingQualifier.end
        });
    }

    if (modifierTokens?.sharingKeyword) {
        ranges.push({
            start: modifierTokens.sharingKeyword.start,
            end: modifierTokens.sharingKeyword.end
        });
    }

    return ranges;
}

/**
 * Copy source bytes inside `range` while omitting mergeable modifier token spans.
 *
 * @param {string} source
 * @param {{ start: number, end: number }} range
 * @param {Array<{ start: number, end: number }>} exclusionRanges
 * @returns {string}
 */
function sliceSourceExcludingRanges(source, range, exclusionRanges) {
    const start = range.start;
    const end = range.end;
    const exclusions = (exclusionRanges || [])
        .filter((item) => item && item.start < end && item.end > start)
        .map((item) => ({
            start: Math.max(item.start, start),
            end: Math.min(item.end, end)
        }))
        .sort((left, right) => left.start - right.start);

    const parts = [];
    let cursor = start;

    for (const exclusion of exclusions) {
        if (exclusion.start > cursor) {
            parts.push(source.slice(cursor, exclusion.start));
        }

        cursor = Math.max(cursor, exclusion.end);
    }

    if (cursor < end) {
        parts.push(source.slice(cursor, end));
    }

    return parts.join('');
}

function assertReconstructableAccess(access) {
    const allowed = new Set([
        OUTER_ACCESS.PUBLIC,
        OUTER_ACCESS.GLOBAL,
        OUTER_ACCESS.UNSPECIFIED
    ]);

    if (!allowed.has(access)) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Outer class access "${access}" cannot be reconstructed (supported: public, global, unspecified).`
        );
    }
}

function assertReconstructableSharing(sharing) {
    const allowed = new Set([
        OUTER_SHARING.WITH,
        OUTER_SHARING.WITHOUT,
        OUTER_SHARING.INHERITED,
        OUTER_SHARING.OMITTED
    ]);

    if (!allowed.has(sharing)) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Unsupported outer class sharing value: ${sharing}`
        );
    }
}

/**
 * Parser-backed description of the root type's outer declaration (Phase 1).
 *
 * @param {object} parsed parseApexClassSource() result
 * @param {string} [sourceText]
 * @returns {object}
 */
function extractRootOuterDeclaration(parsed, sourceText = '') {
    const source = String(
        sourceText || parsed?.sourceText || ''
    );

    if (!parsed?.classes?.length) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'No classes found while extracting outer declaration.'
        );
    }

    const root = parsed.classes.find((entry) => entry.isRoot);

    if (!root?.typeDeclaration || !root?.classDeclaration) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Root type declaration ranges are missing.'
        );
    }

    let bodyBraceIndex =
        root.classBodyOpenBraceIndex != null
            ? root.classBodyOpenBraceIndex
            : null;

    if (bodyBraceIndex == null) {
        bodyBraceIndex = findRootClassBodyBraceIndex(
            source,
            root.classDeclaration.start
        );
    }

    if (bodyBraceIndex < 0 || bodyBraceIndex == null) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Root class body opening brace not found.'
        );
    }

    const typeDeclarationRange = {
        start: root.typeDeclaration.start,
        end: root.typeDeclaration.end
    };
    const headerRange = {
        start: root.typeDeclaration.start,
        end: bodyBraceIndex
    };
    const classClauseRange = {
        start: root.classDeclaration.start,
        end: bodyBraceIndex
    };
    const modifierPrefixRange = {
        start: root.typeDeclaration.start,
        end: root.classDeclaration.start
    };

    const modifierPrefixText = rangeSlice(source, modifierPrefixRange);
    const classClauseText = rangeSlice(source, classClauseRange);
    const headerText = rangeSlice(source, headerRange);
    const modifierTokens = parsed.rootOuterDeclarationModifiers;

    if (!modifierTokens) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Root outer declaration modifier tokens are missing.'
        );
    }

    const access = modifierTokens.access
        ? modifierTokens.access.value
        : OUTER_ACCESS.UNSPECIFIED;
    const sharing = modifierTokens.sharing;
    const accessSourceRange = modifierTokens.access
        ? {
              start: modifierTokens.access.start,
              end: modifierTokens.access.end,
              text: modifierTokens.access.text
          }
        : null;
    const sharingQualifierSourceRange = modifierTokens.sharingQualifier
        ? {
              start: modifierTokens.sharingQualifier.start,
              end: modifierTokens.sharingQualifier.end,
              text: modifierTokens.sharingQualifier.text
          }
        : null;
    const sharingKeywordSourceRange = modifierTokens.sharingKeyword
        ? {
              start: modifierTokens.sharingKeyword.start,
              end: modifierTokens.sharingKeyword.end,
              text: modifierTokens.sharingKeyword.text
          }
        : null;
    const sharingSourceRange =
        sharingQualifierSourceRange && sharingKeywordSourceRange
            ? {
                  start: sharingQualifierSourceRange.start,
                  end: sharingKeywordSourceRange.end
              }
            : null;

    const mergeableModifierRanges = collectMergeableOuterModifierRanges(modifierTokens);
    const leadingNonMergeablePrefix = sliceSourceExcludingRanges(
        source,
        modifierPrefixRange,
        mergeableModifierRanges
    );
    const nonMergeableHeaderText = sliceSourceExcludingRanges(
        source,
        headerRange,
        mergeableModifierRanges
    );

    return {
        access,
        sharing,
        className: parsed.primaryClassName || root.className,
        typeDeclarationRange,
        headerRange,
        classClauseRange,
        modifierPrefixRange,
        bodyRange: {
            start: bodyBraceIndex,
            end: source.length
        },
        classBodyOpenBraceIndex: bodyBraceIndex,
        headerText,
        classClauseText,
        modifierPrefixText,
        accessSourceRange,
        sharingSourceRange,
        sharingQualifierSourceRange,
        sharingKeywordSourceRange,
        modifierTokens,
        leadingNonMergeablePrefix,
        nonMergeableHeaderText
    };
}

/**
 * Replace only outer access/sharing while preserving class clause and body bytes.
 *
 * @param {string} sourceText
 * @param {{ access: string, sharing: string }} selection
 * @returns {string}
 */
function reconstructOuterClassDeclaration(sourceText, selection) {
    const parsed = parseApexClassSource(sourceText);
    const outer = extractRootOuterDeclaration(parsed, sourceText);

    assertReconstructableAccess(selection.access);
    assertReconstructableSharing(selection.sharing);

    const operations = buildOuterDeclarationReplacementOperations(outer, selection);
    const rebuilt = applyTextOperations(sourceText, operations);
    const rebuiltParsed = parseApexClassSource(rebuilt);
    const rebuiltOuter = extractRootOuterDeclaration(rebuiltParsed, rebuilt);

    if (rebuiltOuter.access !== selection.access) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Reconstructed outer access "${rebuiltOuter.access}" does not match requested "${selection.access}".`,
            { rebuiltOuter, selection }
        );
    }

    if (rebuiltOuter.sharing !== selection.sharing) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Reconstructed outer sharing "${rebuiltOuter.sharing}" does not match requested "${selection.sharing}".`,
            { rebuiltOuter, selection }
        );
    }

    return rebuilt;
}

function collectModifierInfo(modifierContexts, source) {
    const accessModifiers = [];
    let isStatic = false;
    const annotations = [];

    for (const modifierCtx of modifierContexts || []) {
        if (modifierCtx.STATIC && modifierCtx.STATIC()) {
            isStatic = true;
        }

        if (modifierCtx.GLOBAL && modifierCtx.GLOBAL()) {
            accessModifiers.push('global');
        }
        if (modifierCtx.PUBLIC && modifierCtx.PUBLIC()) {
            accessModifiers.push('public');
        }
        if (modifierCtx.PROTECTED && modifierCtx.PROTECTED()) {
            accessModifiers.push('protected');
        }
        if (modifierCtx.PRIVATE && modifierCtx.PRIVATE()) {
            accessModifiers.push('private');
        }

        const annotationCtx = modifierCtx.annotation
            ? modifierCtx.annotation()
            : null;

        if (annotationCtx) {
            annotations.push(sliceNodeText(annotationCtx, source));
        }
    }

    const accessModifier =
        accessModifiers.find((m) => m === 'global') ||
        accessModifiers.find((m) => m === 'public') ||
        accessModifiers.find((m) => m === 'protected') ||
        accessModifiers.find((m) => m === 'private') ||
        null;

    return {
        accessModifier,
        isStatic,
        annotations
    };
}

/**
 * Nested class declaration modifiers from classBodyDeclaration modifier_list().
 *
 * @param {Array<object>} modifierContexts
 * @param {string} source
 * @returns {object}
 */
function collectNestedClassModifierInfo(modifierContexts, source) {
    const accessModifiers = [];
    let isStatic = false;
    let isVirtual = false;
    let isAbstract = false;
    const annotations = [];

    for (const modifierCtx of modifierContexts || []) {
        if (modifierCtx.STATIC && modifierCtx.STATIC()) {
            isStatic = true;
        }
        if (modifierCtx.VIRTUAL && modifierCtx.VIRTUAL()) {
            isVirtual = true;
        }
        if (modifierCtx.ABSTRACT && modifierCtx.ABSTRACT()) {
            isAbstract = true;
        }

        if (modifierCtx.GLOBAL && modifierCtx.GLOBAL()) {
            accessModifiers.push('global');
        }
        if (modifierCtx.PUBLIC && modifierCtx.PUBLIC()) {
            accessModifiers.push('public');
        }
        if (modifierCtx.PROTECTED && modifierCtx.PROTECTED()) {
            accessModifiers.push('protected');
        }
        if (modifierCtx.PRIVATE && modifierCtx.PRIVATE()) {
            accessModifiers.push('private');
        }

        const annotationCtx = modifierCtx.annotation
            ? modifierCtx.annotation()
            : null;

        if (annotationCtx) {
            annotations.push(sliceNodeText(annotationCtx, source));
        }
    }

    if (accessModifiers.length > 1) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Ambiguous nested class access modifiers in modifier_list.'
        );
    }

    return {
        accessModifier: accessModifiers[0] || 'unspecified',
        isStatic,
        isVirtual,
        isAbstract,
        annotations
    };
}

function extractParameterTypes(formalParametersCtx, source) {
    if (!formalParametersCtx) {
        return [];
    }

    const listCtx = formalParametersCtx.formalParameterList
        ? formalParametersCtx.formalParameterList()
        : null;

    if (!listCtx) {
        return [];
    }

    const parameters = listCtx.formalParameter_list
        ? listCtx.formalParameter_list()
        : [];

    return parameters.map((paramCtx) => {
        const typeRef = paramCtx.typeRef ? paramCtx.typeRef() : null;
        return normalizeParameterTypeForIdentity(sliceNodeText(typeRef, source));
    });
}

function extractReturnType(methodCtx, source) {
    if (methodCtx.VOID && methodCtx.VOID()) {
        return 'void';
    }

    const typeRef = methodCtx.typeRef ? methodCtx.typeRef() : null;
    return normalizeTypeText(sliceNodeText(typeRef, source)) || 'void';
}

function createListener(
    parseResult,
    source,
    rootTypeDeclarationRange,
    rootClassDeclarationCtx
) {
    const classStack = [];

    function currentQualifiedClassName() {
        return classStack.join('.');
    }

    let pendingNestedMemberDeclaration = null;

    return new (class extends ApexParserBaseListener {
        enterClassBodyDeclaration(ctx) {
            const memberDecl = ctx.memberDeclaration
                ? ctx.memberDeclaration()
                : null;

            if (!memberDecl) {
                return;
            }

            const nestedClassCtx = memberDecl.classDeclaration
                ? memberDecl.classDeclaration()
                : null;

            if (!nestedClassCtx) {
                return;
            }

            pendingNestedMemberDeclaration = {
                classDeclarationCtx: nestedClassCtx,
                modifierInfo: collectNestedClassModifierInfo(
                    ctx.modifier_list ? ctx.modifier_list() : [],
                    source
                ),
                memberDeclarationRange: extractSourceRange(ctx, source)
            };
        }

        enterClassDeclaration(ctx) {
            const className = ctx.id ? ctx.id().getText() : null;

            if (!className) {
                return;
            }

            const parentQualifiedName =
                classStack.length > 0 ? classStack.join('.') : null;
            const isRoot = classStack.length === 0;

            const typeDeclarationRange =
                isRoot && rootTypeDeclarationRange
                    ? rootTypeDeclarationRange
                    : extractSourceRange(ctx, source);

            const classBodyOpenBraceIndex =
                isRoot && ctx === rootClassDeclarationCtx
                    ? resolveRootClassBodyOpenBraceIndex(ctx)
                    : null;

            classStack.push(className);

            let nestedMemberDeclaration = null;

            if (!isRoot) {
                const pending = pendingNestedMemberDeclaration;

                if (
                    !pending ||
                    pending.classDeclarationCtx !== ctx
                ) {
                    throw new ApexMergeError(
                        MERGE_ERROR.PARSE_FAILED,
                        `Could not resolve enclosing classBodyDeclaration for nested class ${className}.`
                    );
                }

                nestedMemberDeclaration = {
                    ...pending.modifierInfo,
                    memberDeclarationRange: pending.memberDeclarationRange
                };
                pendingNestedMemberDeclaration = null;
            }

            const classInfo = {
                className,
                qualifiedName: currentQualifiedClassName(),
                parentQualifiedName,
                isRoot,
                typeDeclaration: typeDeclarationRange,
                classDeclaration: extractSourceRange(ctx, source),
                classBodyOpenBraceIndex,
                nestedMemberDeclaration,
                methods: [],
                constructors: [],
                fields: [],
                properties: [],
                innerClasses: []
            };

            parseResult.classes.push(classInfo);

            if (isRoot) {
                parseResult.primaryClassName = className;
                parseResult.classDeclaration = classInfo.typeDeclaration;
                parseResult.classDeclarationAst = classInfo.classDeclaration;
                parseResult.typeDeclaration = classInfo.typeDeclaration;
                parseResult.rootClassBodyOpenBraceIndex =
                    classBodyOpenBraceIndex;
            } else if (parentQualifiedName) {
                const parentInfo = parseResult.classes.find(
                    (entry) => entry.qualifiedName === parentQualifiedName
                );
                if (parentInfo) {
                    parentInfo.innerClasses.push({
                        className,
                        qualifiedName: classInfo.qualifiedName
                    });
                }
            }
        }

        exitClassDeclaration() {
            classStack.pop();
        }

        exitClassBodyDeclaration(ctx) {
            const memberDecl = ctx.memberDeclaration
                ? ctx.memberDeclaration()
                : null;

            if (!memberDecl) {
                return;
            }

            const declaringClass = parseResult.classes[parseResult.classes.length - 1];

            if (!declaringClass) {
                return;
            }

            const memberModifierInfo = collectModifierInfo(
                ctx.modifier_list ? ctx.modifier_list() : [],
                source
            );

            const memberSource = extractSourceRange(ctx, source);

            const methodCtx = memberDecl.methodDeclaration
                ? memberDecl.methodDeclaration()
                : null;

            if (methodCtx) {
                const methodName = methodCtx.id ? methodCtx.id().getText() : null;

                if (!methodName) {
                    return;
                }

                const parameterTypes = extractParameterTypes(
                    methodCtx.formalParameters(),
                    source
                );
                const method = {
                    kind: 'method',
                    declaringClassName: declaringClass.className,
                    declaringClassQualifiedName: declaringClass.qualifiedName,
                    name: methodName,
                    parameterTypes,
                    identityKey: buildMethodIdentityKey(methodName, parameterTypes),
                    returnType: extractReturnType(methodCtx, source),
                    accessModifier: memberModifierInfo.accessModifier,
                    isStatic: memberModifierInfo.isStatic,
                    annotations: memberModifierInfo.annotations,
                    sourceRange: memberSource,
                    sourceText: memberSource.text
                };

                declaringClass.methods.push(method);
                parseResult.methods.push(method);
                return;
            }

            const ctorCtx = memberDecl.constructorDeclaration
                ? memberDecl.constructorDeclaration()
                : null;

            if (ctorCtx) {
                const qualifiedNameCtx = ctorCtx.qualifiedName
                    ? ctorCtx.qualifiedName()
                    : null;
                const ctorName = qualifiedNameCtx
                    ? qualifiedNameCtx.getText()
                    : declaringClass.className;

                const parameterTypes = extractParameterTypes(
                    ctorCtx.formalParameters(),
                    source
                );

                const constructor = {
                    kind: 'constructor',
                    declaringClassName: declaringClass.className,
                    declaringClassQualifiedName: declaringClass.qualifiedName,
                    name: ctorName,
                    parameterTypes,
                    identityKey: buildMethodIdentityKey(ctorName, parameterTypes),
                    returnType: null,
                    accessModifier: memberModifierInfo.accessModifier,
                    isStatic: false,
                    annotations: memberModifierInfo.annotations,
                    sourceRange: memberSource,
                    sourceText: memberSource.text
                };

                declaringClass.constructors.push(constructor);
                parseResult.constructors.push(constructor);
                parseResult.methods.push(constructor);
                return;
            }

            const fieldCtx = memberDecl.fieldDeclaration
                ? memberDecl.fieldDeclaration()
                : null;

            if (fieldCtx) {
                declaringClass.fields.push({
                    sourceRange: memberSource,
                    sourceText: memberSource.text,
                    typeText: normalizeTypeText(
                        sliceNodeText(fieldCtx.typeRef(), source)
                    ),
                    accessModifier: memberModifierInfo.accessModifier,
                    isStatic: memberModifierInfo.isStatic,
                    annotations: memberModifierInfo.annotations
                });
                return;
            }

            const propertyCtx = memberDecl.propertyDeclaration
                ? memberDecl.propertyDeclaration()
                : null;

            if (propertyCtx) {
                declaringClass.properties.push({
                    sourceRange: memberSource,
                    sourceText: memberSource.text,
                    typeText: normalizeTypeText(
                        sliceNodeText(propertyCtx.typeRef(), source)
                    ),
                    name: propertyCtx.id ? propertyCtx.id().getText() : null,
                    accessModifier: memberModifierInfo.accessModifier,
                    isStatic: memberModifierInfo.isStatic,
                    annotations: memberModifierInfo.annotations
                });
            }
        }

    })();
}

/**
 * Parse Apex class source and extract structural method information.
 *
 * @param {string} source
 * @returns {object}
 */
function parseApexClassSource(source) {
    const sourceText = String(source ?? '');

    if (!sourceText.trim()) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'Apex source is empty.'
        );
    }

    const errorListener = new CollectingApexErrorListener();
    const { parser } = ApexParserFactory.createLexerAndParser(
        sourceText,
        errorListener
    );

    const parseResult = {
        primaryClassName: null,
        classDeclaration: null,
        typeDeclaration: null,
        classes: [],
        methods: [],
        constructors: []
    };

    const tree = parser.compilationUnit();

    if (errorListener.errors.length) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Apex parse failed: ${errorListener.errors[0].message}`,
            {
                errors: errorListener.errors
            }
        );
    }

    const rootTypeCtx = tree.typeDeclaration ? tree.typeDeclaration() : null;
    let rootTypeDeclarationRange = null;
    let rootClassDeclarationCtx = null;

    if (rootTypeCtx) {
        rootTypeDeclarationRange = extractSourceRange(rootTypeCtx, sourceText);

        if (rootTypeCtx.classDeclaration) {
            rootClassDeclarationCtx = rootTypeCtx.classDeclaration();
        }

        parseResult.rootOuterDeclarationModifiers =
            collectRootOuterDeclarationModifiers(rootTypeCtx);
    }

    const listener = createListener(
        parseResult,
        sourceText,
        rootTypeDeclarationRange,
        rootClassDeclarationCtx
    );

    ApexParseTreeWalker.DEFAULT.walk(listener, tree);

    if (errorListener.errors.length) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            `Apex parse failed: ${errorListener.errors[0].message}`,
            {
                errors: errorListener.errors
            }
        );
    }

    if (!parseResult.primaryClassName) {
        throw new ApexMergeError(
            MERGE_ERROR.PARSE_FAILED,
            'No top-level Apex class declaration found.'
        );
    }

    const result = {
        success: true,
        sourceText,
        primaryClassName: parseResult.primaryClassName,
        className: parseResult.primaryClassName,
        classDeclaration: parseResult.classDeclaration,
        classDeclarationAst: parseResult.classDeclarationAst || null,
        typeDeclaration: parseResult.typeDeclaration,
        classes: parseResult.classes,
        methods: parseResult.methods,
        constructors: parseResult.constructors,
        rootOuterDeclarationModifiers: parseResult.rootOuterDeclarationModifiers,
        syntaxErrors: []
    };

    result.outerDeclaration = extractRootOuterDeclaration(result, sourceText);

    return result;
}

module.exports = {
    parseApexClassSource,
    buildMethodIdentityKey,
    extractSourceRange,
    CollectingApexErrorListener,
    OUTER_ACCESS,
    OUTER_SHARING,
    extractRootOuterDeclaration,
    reconstructOuterClassDeclaration,
    collectRootOuterDeclarationModifiers,
    resolveRootClassBodyOpenBraceIndex,
    findRootClassBodyBraceIndex,
    applyTextOperations,
    terminalTokenSpan
};