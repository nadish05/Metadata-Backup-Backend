const path = require('path');

const SYSTEM_CLASSES = new Set([
    'System',
    'String',
    'Integer',
    'Long',
    'Boolean',
    'Decimal',
    'Double',
    'Date',
    'Datetime',
    'Time',
    'List',
    'Set',
    'Map',
    'Math',
    'JSON',
    'Schema',
    'Database',
    'Http',
    'HttpRequest',
    'HttpResponse',
    'RestContext',
    'RestRequest',
    'RestResponse',
    'XmlStreamReader',
    'XmlStreamWriter',
    'Blob',
    'Exception',
    'CalloutException',
    'AuraHandledException',
    'NoAccessException',
    'UserInfo',
    'LoggingLevel',
    'Test',
    'Trigger',
    'Flow',
    'Label',
    'Type',
    'Limits',
    'ApexPages',
    'PageReference',
    'SelectOption',
    'URL',
    // Salesforce platform Apex namespaces and globally available runtime
    // classes. These are provided by the platform and can never resolve to
    // customer-deployable ApexClass artifacts.
    'AppLauncher',
    'Approval',
    'Auth',
    'Cache',
    'Canvas',
    'ChatterAnswers',
    'CommerceBuyGrp',
    'CommerceExtension',
    'CommerceOrders',
    'CommercePayments',
    'CommerceTax',
    'ComplianceMgmt',
    'Compression',
    'ConnectApi',
    'Context',
    'Crypto',
    'Datacloud',
    'DataRetrieval',
    'DataSource',
    'DataWeave',
    'Dom',
    'EncodingUtil',
    'EventBus',
    'ExternalService',
    'FeatureManagement',
    'Flowtesting',
    'FormulaEval',
    'Functions',
    'IndustriesDigitalLending',
    'Invocable',
    'InvoiceWriteOff',
    'IssueCreditMemo',
    'IsvPartners',
    'KbManagement',
    'LxScheduler',
    'Messaging',
    'Metadata',
    'Network',
    'PlaceQuote',
    'Process',
    'QuickAction',
    'Reports',
    'RevSalesTrxn',
    'RevSignaling',
    'RichMessaging',
    'RulesAppln',
    'Search',
    'Security',
    'SessionManagement',
    'Sfc',
    'Sfdc_Checkout',
    'Sfdc_Enablement',
    'Slack',
    'Support',
    'TerritoryMgmt',
    'TxnSecurity',
    'UserProvisioning',
    'VisualEditor',
    'Wave',
    // Salesforce Sites platform Apex (Site.getBaseUrl(), Site.Id, …).
    // Not customer-deployable metadata — classified as PLATFORM_REFERENCE.
    'Site'
]);

function stripLiteralsAndComments(content) {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/'(?:\\'|[^'])*'/g, '')
        .replace(/"(?:\\"|[^"])*"/g, '');
}

function getCurrentClassName(content, filePath) {
    const classMatch = content.match(
        /\b(?:(?:public|global|private)\s+(?:(?:with|without|inherited)\s+sharing\s+)?|(?:(?:with|without|inherited)\s+sharing\s+))(?:virtual\s+|abstract\s+)?class\s+([A-Za-z0-9_]+)/
    );

    if (classMatch) {
        return classMatch[1];
    }

    if (filePath) {
        const baseName = path.basename(filePath, path.extname(filePath));

        if (baseName) {
            return baseName;
        }
    }

    return null;
}

function getInternalTypeDeclarations(content) {
    const declarations = new Set();

    const declarationPatterns = [
        /\b(?:(?:public|global|private|protected)\s+(?:(?:with|without|inherited)\s+sharing\s+)?(?:(?:virtual|abstract)\s+)*|(?:(?:with|without|inherited)\s+sharing\s+)(?:(?:virtual|abstract)\s+)*)class\s+([A-Za-z0-9_]+)/gi,
        /\b(?:public|global|private|protected)\s+interface\s+([A-Za-z0-9_]+)/gi,
        /\b(?:public|global|private|protected)\s+enum\s+([A-Za-z0-9_]+)/gi
    ];

    declarationPatterns.forEach((pattern) => {
        const matches = content.matchAll(pattern);

        for (const match of matches) {
            declarations.add(match[1]);
        }
    });

    return [...declarations];
}

function normalizeApexIdentifier(name) {
    return name ? name.toLowerCase() : '';
}

function uniqueSorted(values) {
    return [...new Set(values)].sort();
}

/**
 * TEMP DIAGNOSTIC — short source window around a match (logging only).
 * @param {string} sourceText
 * @param {string} matchedText
 * @param {number} [maxLen=150]
 * @returns {string|null}
 */
function extractDiagnosticMatchContext(sourceText, matchedText, maxLen = 150) {
    if (!sourceText || !matchedText) {
        return null;
    }

    const idx = String(sourceText).indexOf(matchedText);

    if (idx < 0) {
        const fallback = String(matchedText).replace(/\s+/g, ' ').trim();
        return fallback.length > maxLen ? fallback.slice(0, maxLen) : fallback;
    }

    const pad = Math.max(24, Math.floor((maxLen - matchedText.length) / 2));
    const start = Math.max(0, idx - pad);
    const end = Math.min(sourceText.length, idx + matchedText.length + pad);
    let snippet = String(sourceText)
        .slice(start, end)
        .replace(/\s+/g, ' ')
        .trim();

    if (start > 0) {
        snippet = `…${snippet}`;
    }

    if (end < sourceText.length) {
        snippet = `${snippet}…`;
    }

    if (snippet.length > maxLen) {
        snippet = snippet.slice(0, maxLen);
    }

    return snippet;
}

function isSalesforceMetadataToken(name) {
    return name.endsWith('__c') || name.endsWith('__mdt');
}

function isRelationshipReferenceToken(name) {
    return name.endsWith('__r');
}

/**
 * Standard Salesforce sObjects that must never be emitted as ApexClass
 * dependencies from dotted_reference / new_type. Intentionally narrow —
 * only proven false positives, not a full platform object catalog.
 */
const STANDARD_SOBJECTS_NOT_APEX_CLASS = new Set([
    'Account',
    'Contact',
    'User',
    'Case'
]);

/**
 * Left-hand dotted tokens that are platform/VF globals, not Apex classes.
 */
const DOTTED_REFERENCE_LEFT_EXCLUSIONS = new Set([
    'Page',
    'SObjectType',
    // ApexPages.Severity.ERROR and bare Severity.* platform enum references.
    'Severity'
]);

/**
 * True when name can parent a CustomField (ObjectApiName.Field__c).
 * Accepts custom objects (__c) and PascalCase standard/platform sObjects.
 * Rejects relationship suffixes, Apex system types, and camelCase locals
 * (locals are resolved via extractVariableObjectTypes instead).
 * Generic — no per-object allowlist.
 */
function isApexSystemTypeName(name) {
    const raw = String(name || '').trim();

    if (!raw) {
        return false;
    }

    if (
        raw === 'Id' ||
        raw === 'Object' ||
        raw === 'SObject' ||
        raw === 'Enum' ||
        raw === 'Void'
    ) {
        return true;
    }

    const lower = raw.toLowerCase();

    if (
        lower === 'id' ||
        lower === 'object' ||
        lower === 'sobject' ||
        lower === 'enum' ||
        lower === 'void'
    ) {
        return true;
    }

    for (const systemClass of SYSTEM_CLASSES) {
        if (systemClass.toLowerCase() === lower) {
            return true;
        }
    }

    return false;
}

function isFieldParentObjectName(name) {
    const objectApiName = String(name || '').trim();

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(objectApiName)) {
        return false;
    }

    if (/__(?:r|mdt|e|b|x|kav)$/i.test(objectApiName)) {
        return false;
    }

    if (/__c$/i.test(objectApiName)) {
        return true;
    }

    // Standard / built-in sObject API names are PascalCase in metadata.
    // Dotted refs like Account.Total_Revenue__c use this form.
    if (!/^[A-Z]/.test(objectApiName)) {
        return false;
    }

    if (isApexSystemTypeName(objectApiName)) {
        return false;
    }

    return true;
}

/**
 * Strong SOQL / constructor context may use any casing (Apex is
 * case-insensitive): `FROM case`, `new product2(...)`.
 */
function isStrongContextObjectName(name) {
    const objectApiName = String(name || '').trim();

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(objectApiName)) {
        return false;
    }

    if (/__(?:r|mdt|e|b|x|kav)$/i.test(objectApiName)) {
        return false;
    }

    if (isApexSystemTypeName(objectApiName)) {
        return false;
    }

    return true;
}

/**
 * Emit stable CustomField parent identities for standard sObjects.
 * Custom __c names keep source casing. Standard names get leading capital
 * so `product2` / `case` align with DX folders Product2 / Case.
 */
function normalizeFieldParentObjectApiName(name) {
    const objectApiName = String(name || '').trim();

    if (/__c$/i.test(objectApiName)) {
        return objectApiName;
    }

    if (!objectApiName) {
        return objectApiName;
    }

    return objectApiName.charAt(0).toUpperCase() + objectApiName.slice(1);
}

function extractCustomFieldAssignmentNames(args) {
    const names = [];

    for (const fieldMatch of String(args || '').matchAll(
        /\b([A-Za-z0-9_]+__c)\s*=/gi
    )) {
        names.push(fieldMatch[1]);
    }

    return names;
}

function extractObjectContextNames(cleanedContent) {
    const objectNames = new Set();
    const strongObjectNames = new Set();

    // Strong evidence: real sObject type usage (new / SOQL DML / collections /
    // Schema / for-each / cast / typed method). Weak typed-variable alone is
    // tracked separately so field API names used as "types" can be suppressed.
    const strongObjectPatterns = [
        /\bnew\s+([A-Za-z0-9_]+__c)\b/g,
        /\b(?:FROM|UPDATE|INSERT|DELETE|UPSERT|MERGE|UNDELETE)\s+([A-Za-z0-9_]+__c)\b/gi,
        /\bList<\s*([A-Za-z0-9_]+__c)\s*>/g,
        /\bSet<\s*([A-Za-z0-9_]+__c)\s*>/g,
        /\bMap<\s*[^,>]+\s*,\s*([A-Za-z0-9_]+__c)\s*>/g,
        /\bSchema\.SObjectType\.([A-Za-z0-9_]+__c)\b/g,
        /\bfor\s*\(\s*([A-Za-z0-9_]+__c)\s+[a-z][A-Za-z0-9_]*\s*:/gi,
        /\(\s*([A-Za-z0-9_]+__c)\s*\)/g,
        /\b([A-Za-z0-9_]+__c)\s+[a-z][A-Za-z0-9_]*\s*\(/g
    ];

    const weakObjectPatterns = [
        /\b([A-Za-z0-9_]+__c)\s+[a-z][A-Za-z0-9_]*\b/g
    ];

    strongObjectPatterns.forEach((pattern) => {
        for (const match of cleanedContent.matchAll(pattern)) {
            objectNames.add(match[1]);
            strongObjectNames.add(match[1]);
        }
    });

    weakObjectPatterns.forEach((pattern) => {
        for (const match of cleanedContent.matchAll(pattern)) {
            objectNames.add(match[1]);
        }
    });

    const dottedFieldRefs =
        cleanedContent.match(
            /\b([A-Za-z0-9_]+__c)\.([A-Za-z0-9_]+__c)\b/g
        ) || [];

    dottedFieldRefs.forEach((fieldRef) => {
        const objectApiName = fieldRef.split('.')[0];
        objectNames.add(objectApiName);
        strongObjectNames.add(objectApiName);
    });

    const objectPropertyAccess = cleanedContent.matchAll(
        /\b([A-Za-z0-9_]+__c)\.[A-Za-z0-9_]+/g
    );

    for (const match of objectPropertyAccess) {
        objectNames.add(match[1]);
        strongObjectNames.add(match[1]);
    }

    return { objectNames, strongObjectNames };
}

/**
 * Map local Apex variable names to their sObject types (custom or standard).
 * Example: "Comparison_Result__c row" → row => Comparison_Result__c
 * Example: "Case cc" / "for (Case cc :" → cc => Case
 * Example: "product2 equipment" → equipment => Product2
 */
function extractVariableObjectTypes(cleanedContent) {
    const variableTypes = new Map();

    const patterns = [
        /\b([A-Za-z0-9_]+__c)\s+([a-zA-Z][A-Za-z0-9_]*)\b/g,
        /\bfor\s*\(\s*([A-Za-z0-9_]+__c)\s+([a-zA-Z][A-Za-z0-9_]*)\s*:/gi,
        // Standard / platform sObject typed variables (any Apex casing).
        /\b([A-Za-z][A-Za-z0-9_]*)\s+([a-z][A-Za-z0-9_]*)\b/g,
        /\bfor\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s+([a-zA-Z][A-Za-z0-9_]*)\s*:/gi
    ];

    for (const pattern of patterns) {
        for (const match of cleanedContent.matchAll(pattern)) {
            const objectType = match[1];
            const variableName = match[2];

            if (!isStrongContextObjectName(objectType)) {
                continue;
            }

            const normalizedType = normalizeFieldParentObjectApiName(objectType);

            if (!variableTypes.has(variableName)) {
                variableTypes.set(variableName, normalizedType);
            }
        }
    }

    return variableTypes;
}

/**
 * Qualify SOQL SELECT __c fields with the correct object parent.
 *
 * - Bare fields → FROM object: Booked_Slots__c → Session__c.Booked_Slots__c
 * - Relationship fields → related object:
 *   Experience__r.Price__c → Experience__c.Price__c
 *   (never FROMObject.Price__c)
 *
 * Relationship__r.Field__c is rewritten to Relationship__c.Field__c when
 * Relationship__c has independent strong CustomObject evidence in the same
 * analysis unit.
 *
 * When that strong-object evidence is absent, an optional metadata-backed
 * fallback resolves FROM.LookupField__c → <referenceTo> → Target.Field__c
 * (standard or custom). Never invents Equipment__c.Maintenance_Cycle__c
 * from the relationship name alone.
 *
 * @param {string} cleanedContent
 * @param {Set<string>} [strongObjectNames]
 * @param {Map<string, string[]>|null} [lookupReferenceTargets]
 */
function extractSoqlQualifiedFields(
    cleanedContent,
    strongObjectNames = new Set(),
    lookupReferenceTargets = null
) {
    const {
        resolveLookupReferenceTargets
    } = require('./apexSoqlLookupTarget.service');

    const qualifiedFields = new Set();
    const soqlBlocks = cleanedContent.matchAll(/\[([\s\S]*?)\]/g);

    for (const block of soqlBlocks) {
        const query = block[1];

        if (!/\bSELECT\b/i.test(query) || !/\bFROM\b/i.test(query)) {
            continue;
        }

        // Custom (__c) and standard sObjects (any Apex casing: Account / case).
        const fromMatch = query.match(/\bFROM\s+([A-Za-z][A-Za-z0-9_]*)\b/i);

        if (!fromMatch) {
            continue;
        }

        const rawObjectName = fromMatch[1];

        if (!isStrongContextObjectName(rawObjectName)) {
            continue;
        }

        const objectName = normalizeFieldParentObjectApiName(rawObjectName);

        const selectMatch = query.match(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i);

        if (!selectMatch) {
            continue;
        }

        const selectClause = selectMatch[1];

        // 1) Relationship-qualified fields: Relationship__r.Field__c
        //    a) Strong-object path: Relationship__c.Field__c when proven object
        //    b) Else metadata fallback: FROM.Lookup__c → referenceTo → Target.Field
        for (const match of selectClause.matchAll(
            /\b([A-Za-z0-9_]+__r)\.([A-Za-z0-9_]+__c)\b/g
        )) {
            const relationshipName = match[1];
            const fieldApiName = match[2];
            const relatedObjectApiName = relationshipName.replace(
                /__r$/i,
                '__c'
            );

            if (strongObjectNames.has(relatedObjectApiName)) {
                const qualified = `${relatedObjectApiName}.${fieldApiName}`;
                qualifiedFields.add(qualified);
                continue;
            }

            const referenceToValues = resolveLookupReferenceTargets(
                lookupReferenceTargets,
                objectName,
                relatedObjectApiName
            );

            if (!referenceToValues.length) {
                continue;
            }

            // Owning lookup/MD field on the FROM object (needed for __r path).
            qualifiedFields.add(`${objectName}.${relatedObjectApiName}`);

            for (const referenceTo of referenceToValues) {
                const targetObjectApiName =
                    normalizeFieldParentObjectApiName(referenceTo);

                if (!isFieldParentObjectName(targetObjectApiName)) {
                    continue;
                }

                qualifiedFields.add(
                    `${targetObjectApiName}.${fieldApiName}`
                );
            }
        }

        // 2) Bare SELECT fields (exclude relationship-qualified segments so
        //    Price__c from Experience__r.Price__c is not attached to FROM).
        const selectWithoutRelationships = selectClause.replace(
            /\b[A-Za-z0-9_]+__r\.[A-Za-z0-9_]+__c\b/g,
            ' '
        );
        const fieldTokens =
            selectWithoutRelationships.match(/\b[A-Za-z0-9_]+__c\b/gi) || [];

        for (const fieldName of fieldTokens) {
            if (fieldName.toLowerCase() !== objectName.toLowerCase()) {
                const qualified = `${objectName}.${fieldName}`;
                qualifiedFields.add(qualified);
            }
        }
    }

    return qualifiedFields;
}

/**
 * Bare __c field API names appearing in SOQL SELECT clauses (before qualification).
 * Used to suppress weak-only CustomObject promotion for field tokens.
 */
function extractSoqlSelectFieldTokens(cleanedContent) {
    const fieldTokens = new Set();
    const soqlBlocks = cleanedContent.matchAll(/\[([\s\S]*?)\]/g);

    for (const block of soqlBlocks) {
        const query = block[1];

        if (!/\bSELECT\b/i.test(query) || !/\bFROM\b/i.test(query)) {
            continue;
        }

        const selectMatch = query.match(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i);

        if (!selectMatch) {
            continue;
        }

        const selectClause = selectMatch[1];
        const selectWithoutRelationships = selectClause.replace(
            /\b[A-Za-z0-9_]+__r\.[A-Za-z0-9_]+__c\b/g,
            ' '
        );
        const tokens =
            selectWithoutRelationships.match(/\b[A-Za-z0-9_]+__c\b/g) || [];

        for (const token of tokens) {
            fieldTokens.add(token);
        }
    }

    return fieldTokens;
}

/**
 * Bare __c field tokens in SOQL WHERE / GROUP BY / HAVING / ORDER BY clauses.
 * These are field references on the FROM object, not CustomObject type usage.
 * Example: WHERE Maintenance_Request__c IN :ids
 */
function extractSoqlFilterFieldTokens(cleanedContent) {
    const fieldTokens = new Set();
    const soqlBlocks = cleanedContent.matchAll(/\[([\s\S]*?)\]/g);

    for (const block of soqlBlocks) {
        const query = block[1];

        if (!/\bSELECT\b/i.test(query) || !/\bFROM\b/i.test(query)) {
            continue;
        }

        const fromMatch = query.match(/\bFROM\s+([A-Za-z0-9_]+(?:__c|__mdt)?)\b/i);
        const fromObjectName = fromMatch ? fromMatch[1] : null;

        const clauseMatchers = [
            /\bWHERE\b([\s\S]*?)(?=\b(?:GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|FOR\s+UPDATE|WITH)\b|$)/i,
            /\bGROUP\s+BY\b([\s\S]*?)(?=\b(?:HAVING|ORDER\s+BY|LIMIT|OFFSET|FOR\s+UPDATE|WITH)\b|$)/i,
            /\bHAVING\b([\s\S]*?)(?=\b(?:ORDER\s+BY|LIMIT|OFFSET|FOR\s+UPDATE|WITH)\b|$)/i,
            /\bORDER\s+BY\b([\s\S]*?)(?=\b(?:LIMIT|OFFSET|FOR\s+UPDATE|WITH)\b|$)/i
        ];

        for (const matcher of clauseMatchers) {
            const clauseMatch = query.match(matcher);
            if (!clauseMatch) {
                continue;
            }

            const clause = clauseMatch[1] || '';
            const tokens = clause.match(/\b[A-Za-z0-9_]+__c\b/g) || [];

            for (const token of tokens) {
                if (fromObjectName && token === fromObjectName) {
                    continue;
                }
                fieldTokens.add(token);
            }
        }
    }

    return fieldTokens;
}

/**
 * Extract text between a '(' at openParenIndex and its matching ')'.
 * Nested parentheses increment depth; only depth 0 closes the span.
 * Operates on cleaned Apex (literals/comments already stripped upstream).
 * @returns {string|null} argument text, or null if unbalanced
 */
function extractBalancedParenContents(text, openParenIndex) {
    if (
        typeof text !== 'string' ||
        openParenIndex < 0 ||
        openParenIndex >= text.length ||
        text[openParenIndex] !== '('
    ) {
        return null;
    }

    let depth = 1;

    for (let i = openParenIndex + 1; i < text.length; i++) {
        const ch = text[i];

        if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            depth -= 1;

            if (depth === 0) {
                return text.slice(openParenIndex + 1, i);
            }
        }
    }

    return null;
}

/**
 * Named field assignments inside `new SObject(Field__c = value, ...)`.
 * Supports custom objects (__c) and standard sObjects (Product2, Case, …),
 * including Apex case variants (`new product2(...)`, `lifespan_months__C`).
 * Uses balanced-paren scan so nested calls like err.getMessage() do not
 * truncate the constructor argument list.
 * Returns qualified CustomField identities ObjectApiName.Field__c.
 */
function extractSObjectConstructorNamedFields(cleanedContent) {
    const qualifiedFields = new Set();
    const text = String(cleanedContent || '');
    const startPattern = /\bnew\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
    let match;

    while ((match = startPattern.exec(text)) !== null) {
        const rawObjectApiName = match[1];
        const openParenIndex = match.index + match[0].length - 1;

        if (!isStrongContextObjectName(rawObjectApiName)) {
            continue;
        }

        const args = extractBalancedParenContents(text, openParenIndex);

        if (args === null) {
            continue;
        }

        // Resume after this constructor's closing ')' so nested scans stay
        // independent and we do not re-enter the same argument span.
        startPattern.lastIndex = openParenIndex + 1 + args.length + 1;

        const objectApiName =
            normalizeFieldParentObjectApiName(rawObjectApiName);

        for (const fieldName of extractCustomFieldAssignmentNames(args)) {
            qualifiedFields.add(`${objectApiName}.${fieldName}`);
        }
    }

    return qualifiedFields;
}

/**
 * Local Apex variable names (case-insensitive keys) for suppressing false
 * ApexClass dotted references like ClonedWPs.add(...) when clonedWPs is local.
 */
function extractLocalVariableNames(cleanedContent) {
    const variableNames = new Set();

    const patterns = [
        /\b(?:List|Set)\s*<[^>;]+?>\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
        /\bMap\s*<[^>;]+?>\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
        /\b(?:String|Integer|Boolean|Decimal|Double|Long|Date|Datetime|Id|Object|SObject|Blob|Time)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
        /\b([A-Za-z][A-Za-z0-9_]*__c)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
        /\bfor\s*\(\s*(?:List|Set)\s*<[^>;]+?>\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gi,
        /\bfor\s*\(\s*([A-Za-z][A-Za-z0-9_]*(?:__c)?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gi
    ];

    for (const pattern of patterns) {
        for (const match of cleanedContent.matchAll(pattern)) {
            const variableName = match[2] || match[1];
            if (!variableName || /__c$/i.test(variableName)) {
                continue;
            }
            variableNames.add(normalizeApexIdentifier(variableName));
        }
    }

    return variableNames;
}

function classifyCustomObjectsAndFields(
    cleanedContent,
    lookupReferenceTargets = null
) {
    const { objectNames, strongObjectNames } =
        extractObjectContextNames(cleanedContent);
    const customObjects = [];
    // Salesforce CustomField identity is always ObjectApiName.FieldApiName.
    // Never emit bare __c field tokens — that loses parent context.
    const customFields = new Set();

    // 1) Qualified ObjectApiName.Field__c — custom (__c) and standard sObjects.
    //    Relationship parents (__r) are excluded (handled by SOQL __r rewrite).
    for (const match of cleanedContent.matchAll(
        /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+__c)\b/g
    )) {
        const objectApiName = match[1];
        const fieldApiName = match[2];

        if (!isFieldParentObjectName(objectApiName)) {
            continue;
        }

        customFields.add(`${objectApiName}.${fieldApiName}`);
    }

    // 2) Qualify variable.Field__c using declared variable object types.
    const variableTypes = extractVariableObjectTypes(cleanedContent);

    for (const match of cleanedContent.matchAll(
        /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+__c)\b/g
    )) {
        const receiver = match[1];
        const fieldName = match[2];

        // ObjectApiName.Field__c already handled above when receiver is an
        // sObject API name (custom or standard).
        if (isFieldParentObjectName(receiver)) {
            continue;
        }

        const objectType = variableTypes.get(receiver);

        if (objectType) {
            const qualified = `${objectType}.${fieldName}`;
            customFields.add(qualified);
        }
    }

    // 3) Qualify SOQL SELECT fields with the FROM object / proven related objects.
    for (const qualifiedField of extractSoqlQualifiedFields(
        cleanedContent,
        strongObjectNames,
        lookupReferenceTargets
    )) {
        customFields.add(qualifiedField);
    }

    for (const qualifiedField of extractSObjectConstructorNamedFields(
        cleanedContent
    )) {
        customFields.add(qualifiedField);
    }

    const customFieldSegments = new Set(
        [...customFields]
            .map((qualified) => {
                const parts = String(qualified).split('.');
                return parts.length === 2 ? parts[1] : null;
            })
            .filter(Boolean)
    );
    const soqlSelectFieldTokens = extractSoqlSelectFieldTokens(cleanedContent);
    const soqlFilterFieldTokens = extractSoqlFilterFieldTokens(cleanedContent);

    // 4) Remaining __c tokens with object context are CustomObjects.
    //    Unqualified __c tokens are NOT CustomFields (invalid identity).
    //    Field API names already known as CustomField segments or SOQL SELECT
    //    tokens must not be promoted — including when strong object-context
    //    patterns matched (method return, for-each, cast, new, FROM, etc.).
    const allTokens = uniqueSorted(
        cleanedContent.match(/\b[A-Za-z0-9_]+__c\b/g) || []
    );

    allTokens.forEach((token) => {
        if (!objectNames.has(token)) {
            return;
        }

        if (
            customFieldSegments.has(token) ||
            soqlSelectFieldTokens.has(token) ||
            soqlFilterFieldTokens.has(token)
        ) {
            return;
        }

        customObjects.push(token);
    });

    return {
        customObjects: uniqueSorted(customObjects),
        customFields: uniqueSorted([...customFields])
    };
}

function classifyRelationshipReferences(cleanedContent) {
    return uniqueSorted(
        cleanedContent.match(/\b[A-Za-z0-9_]+__r\b/g) || []
    );
}

/**
 * Bare CMDT type tokens (MyType__mdt) — these are CustomObject metadata,
 * not CustomMetadata records.
 */
function extractCustomMetadataTypes(cleanedContent) {
    return uniqueSorted(
        cleanedContent.match(/\b[A-Za-z][A-Za-z0-9_]*__mdt\b/g) || []
    );
}

/**
 * CustomMetadata RECORD members in canonical Type.Record form.
 * Prefer getInstance / SOQL DeveloperName; avoid bare __mdt type tokens.
 */
function extractCustomMetadataRecords(cleanedContent) {
    const records = new Set();

    for (const match of cleanedContent.matchAll(
        /\b([A-Za-z][A-Za-z0-9_]*)__mdt\.getInstance\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]\s*\)/g
    )) {
        records.add(`${match[1]}.${match[2]}`);
    }

    for (const match of cleanedContent.matchAll(
        /\bFROM\s+([A-Za-z][A-Za-z0-9_]*)__mdt\b([\s\S]{0,240}?)(?=;|\])/gi
    )) {
        const typeDeveloperName = match[1];
        const clause = match[2] || '';

        for (const developerNameMatch of clause.matchAll(
            /\bDeveloperName\s*=\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/gi
        )) {
            records.add(`${typeDeveloperName}.${developerNameMatch[1]}`);
        }
    }

    return uniqueSorted([...records]);
}

/**
 * @param {string} content
 * @param {string} [currentClassName]
 * @param {{
 *   lookupReferenceTargets?: Map<string, string[]>|null
 * }} [options]
 *   Optional Map of "FromObject.LookupField__c" → referenceTo API names
 *   for SOQL Relationship__r.Field__c metadata-backed resolution.
 */
function analyzeApexContent(content, currentClassName, options = {}) {
    const cleanedContent = stripLiteralsAndComments(content);
    const internalDeclarations = getInternalTypeDeclarations(content);
    const outerClassName = currentClassName || getCurrentClassName(content);
    const normalizedOuterClassName = normalizeApexIdentifier(outerClassName);
    const lookupReferenceTargets =
        options && options.lookupReferenceTargets instanceof Map
            ? options.lookupReferenceTargets
            : null;

    const internalTypesToExclude = internalDeclarations.filter(
        (name) =>
            normalizeApexIdentifier(name) !== normalizedOuterClassName
    );

    const { customObjects: objectTokens, customFields } =
        classifyCustomObjectsAndFields(
            cleanedContent,
            lookupReferenceTargets
        );

    const relationshipReferences =
        classifyRelationshipReferences(cleanedContent);

    // Phase 5G.2: bare __mdt → CustomObject; Type.Record → CustomMetadata.
    // Record extraction uses original content so string literals in
    // getInstance('Record') / DeveloperName = 'Record' are preserved.
    const customMetadataTypes = extractCustomMetadataTypes(cleanedContent);
    const customMetadata = extractCustomMetadataRecords(content);
    const customObjects = uniqueSorted([
        ...objectTokens,
        ...customMetadataTypes
    ]);

    const contentForClassRefs = cleanedContent
        .replace(/\bFlow\.Interview\.[A-Za-z0-9_]+\b/g, '')
        .replace(/\bApexPages\.Severity\.[A-Za-z0-9_]+\b/g, '')
        .replace(/\b[A-Za-z0-9_]+__r\./g, '');

    // Visualforce Page.X member names are ApexPage references, not ApexClass.
    const visualforcePageNames = new Set();

    for (const match of cleanedContent.matchAll(
        /\bPage\.([A-Za-z][A-Za-z0-9_]*)\b/g
    )) {
        visualforcePageNames.add(match[1]);
    }

    const localVariableNames = extractLocalVariableNames(cleanedContent);

    // Same dotted / new_type regex shapes as before; structural emission
    // guards (Page / SObjectType / standard sObjects / __c members) applied below.
    const constructorMatches =
        contentForClassRefs.match(
            /\bnew\s+([A-Z][A-Za-z0-9_]+)\b/g
        ) || [];

    const flowRefs =
        cleanedContent.match(
            /\bFlow\.Interview\.([A-Za-z0-9_]+)\b/g
        ) || [];

    const triggerRefs =
        cleanedContent.match(
            /\b[A-Z][A-Za-z0-9_]*Trigger\b/g
        ) || [];

    const labelRefs =
        cleanedContent.match(
            /\b(?:System\.)?Label\.([A-Za-z0-9_]+)\b/g
        ) || [];

    const namedCredentialMatches =
        content.match(
            /callout:([A-Za-z0-9_]+)/g
        ) || [];

    const excludedClasses = new Set([
        ...[...SYSTEM_CLASSES].map(normalizeApexIdentifier),
        ...internalTypesToExclude.map(normalizeApexIdentifier),
        ...(normalizedOuterClassName ? [normalizedOuterClassName] : [])
    ]);

    function isEmittedApexClass(name) {
        return (
            !excludedClasses.has(normalizeApexIdentifier(name)) &&
            !STANDARD_SOBJECTS_NOT_APEX_CLASS.has(name) &&
            !visualforcePageNames.has(name) &&
            !isSalesforceMetadataToken(name) &&
            !isRelationshipReferenceToken(name)
        );
    }

    function shouldEmitDottedReferenceAsApexClass(name, memberName) {
        // Field access (standard or custom object): Account.Total_Revenue__c
        if (
            memberName &&
            (memberName.endsWith('__c') || memberName.endsWith('__mdt'))
        ) {
            return false;
        }

        // VF Page.X and Schema.SObjectType.X middle token
        if (DOTTED_REFERENCE_LEFT_EXCLUSIONS.has(name)) {
            return false;
        }

        // Local variable.member (e.g. ClonedWPs.add) is not an ApexClass.
        if (localVariableNames.has(normalizeApexIdentifier(name))) {
            return false;
        }

        return isEmittedApexClass(name);
    }

    // Emission filters for dotted_reference / new_type (regex shapes unchanged).
    // Structural guards suppress proven false positives only.
    const dottedApexByName = new Map();
    for (const match of contentForClassRefs.matchAll(
        /\b([A-Z][A-Za-z0-9_]+)\./g
    )) {
        const name = match[1];
        const matchedPrefix = match[0];
        const after = contentForClassRefs.slice(
            match.index + matchedPrefix.length
        );
        const trailing = after.match(/^([A-Za-z][A-Za-z0-9_]*)/);
        const memberName = trailing ? trailing[1] : '';

        if (!shouldEmitDottedReferenceAsApexClass(name, memberName)) {
            continue;
        }

        if (!dottedApexByName.has(name)) {
            const matchedText = memberName
                ? `${matchedPrefix}${memberName}`
                : matchedPrefix;
            dottedApexByName.set(name, {
                matchedText,
                context: extractDiagnosticMatchContext(
                    contentForClassRefs,
                    matchedText
                ),
                _enriched: Boolean(memberName)
            });
        }
    }

    const newTypeApexByName = new Map();
    for (const match of constructorMatches) {
        const name = match.replace(/^new\s+/, '');
        if (!isEmittedApexClass(name)) {
            continue;
        }
        if (!newTypeApexByName.has(name)) {
            newTypeApexByName.set(name, {
                matchedText: match,
                context: extractDiagnosticMatchContext(
                    contentForClassRefs,
                    match
                )
            });
        }
    }

    const apexClasses = uniqueSorted([
        ...dottedApexByName.keys(),
        ...newTypeApexByName.keys()
    ]);

    const customMetadataTypeSet = new Set(customMetadataTypes);
    const objectTokenSet = new Set(objectTokens);

    const apexDependencyDebug = [];

    for (const name of apexClasses) {
        const fromDotted = dottedApexByName.get(name);
        const fromNew = newTypeApexByName.get(name);
        let detectedBy = 'other';
        let matchedText = name;
        let context = null;
        let sourceCategory = 'other';
        let reason =
            'Emitted as ApexClass by analyzer without a classified match mechanism.';

        if (fromDotted) {
            detectedBy = 'dotted_reference';
            matchedText = fromDotted.matchedText;
            context = fromDotted.context;
            sourceCategory = 'apex_class_reference';
            reason =
                "Matched capitalized identifier followed by '.' (class-ref / Type.Member pattern).";
        } else if (fromNew) {
            detectedBy = 'new_type';
            matchedText = fromNew.matchedText;
            context = fromNew.context;
            sourceCategory = 'apex_constructor';
            reason = "Matched 'new TypeName' constructor expression.";
        }

        apexDependencyDebug.push({
            name,
            dependencyName: name,
            detectedBy,
            metadataType: 'ApexClass',
            source: 'ApexAnalyzer',
            sourceSnippetOrMatch: matchedText,
            matchedText,
            context,
            sourceCategory,
            reason,
            sourceClass: outerClassName || null
        });
    }

    for (const name of customFields) {
        const matchedText = name;
        const context = extractDiagnosticMatchContext(cleanedContent, matchedText);

        apexDependencyDebug.push({
            name,
            dependencyName: name,
            detectedBy: 'qualified_field',
            metadataType: 'CustomField',
            source: 'ApexAnalyzer',
            sourceSnippetOrMatch: matchedText,
            matchedText,
            context,
            sourceCategory: 'custom_field_reference',
            reason:
                'Matched qualified CustomField identity Object__c.Field__c (or analyzer-qualified equivalent).',
            sourceClass: outerClassName || null
        });
    }

    for (const name of customObjects) {
        let detectedBy = 'other';
        let sourceCategory = 'other';
        let reason =
            'Emitted as CustomObject by analyzer without a bare-token classification.';

        if (customMetadataTypeSet.has(name)) {
            detectedBy = 'other';
            sourceCategory = 'custom_metadata_type';
            reason =
                'Matched bare Custom Metadata Type token (__mdt) classified as CustomObject.';
        } else if (objectTokenSet.has(name)) {
            detectedBy = 'bare_custom_token';
            sourceCategory = 'custom_object_token';
            reason =
                'Matched __c token present in object-context extraction (bare custom identifier treated as CustomObject).';
        }

        const matchedText = name;
        const context = extractDiagnosticMatchContext(cleanedContent, matchedText);

        apexDependencyDebug.push({
            name,
            dependencyName: name,
            detectedBy,
            metadataType: 'CustomObject',
            source: 'ApexAnalyzer',
            sourceSnippetOrMatch: matchedText,
            matchedText,
            context,
            sourceCategory,
            reason,
            sourceClass: outerClassName || null
        });
    }

    // TEMP DIAGNOSTIC — APEX DEPENDENCY PROVENANCE DEBUG (logging only).
    console.log('========================================');
    console.log('APEX DEPENDENCY PROVENANCE DEBUG');
    console.log('========================================');
    console.log(
        JSON.stringify({
            sourceClass: outerClassName || null,
            dependencyCount: apexDependencyDebug.length
        })
    );
    for (const row of apexDependencyDebug) {
        console.log(
            JSON.stringify({
                dependencyName: row.dependencyName,
                metadataType: row.metadataType,
                detectedBy: row.detectedBy,
                matchedText: row.matchedText,
                context: row.context,
                sourceCategory: row.sourceCategory,
                reason: row.reason,
                sourceClass: row.sourceClass || null
            })
        );
    }
    console.log('========================================');

    return {
        customObjects,
        customFields,
        relationshipReferences,
        apexClasses,
        triggers: uniqueSorted(triggerRefs),
        flows: uniqueSorted(
            flowRefs.map((ref) =>
                ref.replace('Flow.Interview.', '')
            )
        ),
        customMetadata: uniqueSorted(customMetadata),
        namedCredentials: uniqueSorted(
            namedCredentialMatches.map((match) =>
                match.replace('callout:', '')
            )
        ),
        labels: uniqueSorted(
            labelRefs.map((ref) =>
                ref.replace(/^(?:System\.)?Label\./, '')
            )
        ),
        // TEMP DIAGNOSTIC only — ignored by decision logic.
        apexDependencyDebug
    };
}

/**
 * Analyze Apex with repository field metadata so SOQL Relationship__r
 * fields can resolve Lookup/MasterDetail referenceTo targets.
 */
async function analyzeApexContentWithRepository(
    content,
    currentClassName,
    { readRepoFile, listRepoFiles } = {}
) {
    const {
        buildLookupReferenceTargetMap
    } = require('./apexSoqlLookupTarget.service');

    if (typeof readRepoFile !== 'function' || typeof listRepoFiles !== 'function') {
        return analyzeApexContent(content, currentClassName);
    }

    const repoFiles = await listRepoFiles();
    const cleanedContent = stripLiteralsAndComments(content);
    const lookupReferenceTargets = await buildLookupReferenceTargetMap({
        cleanedContent,
        repoFiles,
        readRepoFile,
        normalizeObjectApiName: normalizeFieldParentObjectApiName
    });

    return analyzeApexContent(content, currentClassName, {
        lookupReferenceTargets
    });
}

module.exports = {
    analyzeApexContent,
    analyzeApexContentWithRepository,
    getCurrentClassName,
    extractCustomMetadataTypes,
    extractCustomMetadataRecords,
    SYSTEM_CLASSES,
    stripLiteralsAndComments,
    normalizeFieldParentObjectApiName
};
