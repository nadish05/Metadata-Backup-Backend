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

function createListener(parseResult, source, rootTypeDeclarationRange) {
    const classStack = [];

    function currentQualifiedClassName() {
        return classStack.join('.');
    }

    return new (class extends ApexParserBaseListener {
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

            classStack.push(className);

            const classInfo = {
                className,
                qualifiedName: currentQualifiedClassName(),
                parentQualifiedName,
                isRoot,
                typeDeclaration: typeDeclarationRange,
                classDeclaration: extractSourceRange(ctx, source),
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

    if (rootTypeCtx) {
        rootTypeDeclarationRange = extractSourceRange(rootTypeCtx, sourceText);
    }

    const listener = createListener(
        parseResult,
        sourceText,
        rootTypeDeclarationRange
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

    return {
        success: true,
        primaryClassName: parseResult.primaryClassName,
        className: parseResult.primaryClassName,
        classDeclaration: parseResult.classDeclaration,
        classDeclarationAst: parseResult.classDeclarationAst || null,
        typeDeclaration: parseResult.typeDeclaration,
        classes: parseResult.classes,
        methods: parseResult.methods,
        constructors: parseResult.constructors,
        syntaxErrors: []
    };
}

module.exports = {
    parseApexClassSource,
    buildMethodIdentityKey,
    extractSourceRange,
    CollectingApexErrorListener
};