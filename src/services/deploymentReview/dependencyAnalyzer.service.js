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

function isSalesforceMetadataToken(name) {
    return name.endsWith('__c') || name.endsWith('__mdt');
}

function isRelationshipReferenceToken(name) {
    return name.endsWith('__r');
}

function extractObjectContextNames(cleanedContent) {
    const objectNames = new Set();

    const objectPatterns = [
        /\bnew\s+([A-Za-z0-9_]+__c)\b/g,
        /\b(?:FROM|UPDATE|INSERT|DELETE|UPSERT|MERGE|UNDELETE)\s+([A-Za-z0-9_]+__c)\b/gi,
        /\bList<\s*([A-Za-z0-9_]+__c)\s*>/g,
        /\bSet<\s*([A-Za-z0-9_]+__c)\s*>/g,
        /\bMap<\s*[^,>]+\s*,\s*([A-Za-z0-9_]+__c)\s*>/g,
        /\bSchema\.SObjectType\.([A-Za-z0-9_]+__c)\b/g,
        /\b([A-Za-z0-9_]+__c)\s+[a-z][A-Za-z0-9_]*\b/g,
        /\bfor\s*\(\s*([A-Za-z0-9_]+__c)\s+[a-z][A-Za-z0-9_]*\s*:/gi,
        /\(\s*([A-Za-z0-9_]+__c)\s*\)/g,
        /\b([A-Za-z0-9_]+__c)\s+[a-z][A-Za-z0-9_]*\s*\(/g
    ];

    objectPatterns.forEach((pattern) => {
        const matches = cleanedContent.matchAll(pattern);

        for (const match of matches) {
            objectNames.add(match[1]);
        }
    });

    const dottedFieldRefs =
        cleanedContent.match(
            /\b([A-Za-z0-9_]+__c)\.([A-Za-z0-9_]+__c)\b/g
        ) || [];

    dottedFieldRefs.forEach((fieldRef) => {
        objectNames.add(fieldRef.split('.')[0]);
    });

    const objectPropertyAccess = cleanedContent.matchAll(
        /\b([A-Za-z0-9_]+__c)\.[A-Za-z0-9_]+/g
    );

    for (const match of objectPropertyAccess) {
        objectNames.add(match[1]);
    }

    return objectNames;
}

/**
 * Map local Apex variable names to their CustomObject types.
 * Example: "Comparison_Result__c row" → row => Comparison_Result__c
 */
function extractVariableObjectTypes(cleanedContent) {
    const variableTypes = new Map();

    const patterns = [
        /\b([A-Za-z0-9_]+__c)\s+([a-zA-Z][A-Za-z0-9_]*)\b/g,
        /\bfor\s*\(\s*([A-Za-z0-9_]+__c)\s+([a-zA-Z][A-Za-z0-9_]*)\s*:/gi
    ];

    for (const pattern of patterns) {
        for (const match of cleanedContent.matchAll(pattern)) {
            const objectType = match[1];
            const variableName = match[2];

            if (!variableTypes.has(variableName)) {
                variableTypes.set(variableName, objectType);
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
 */
function extractSoqlQualifiedFields(cleanedContent) {
    const qualifiedFields = new Set();
    const soqlBlocks = cleanedContent.matchAll(/\[([\s\S]*?)\]/g);

    for (const block of soqlBlocks) {
        const query = block[1];

        if (!/\bSELECT\b/i.test(query) || !/\bFROM\b/i.test(query)) {
            continue;
        }

        const fromMatch = query.match(/\bFROM\s+([A-Za-z0-9_]+__c)\b/i);

        if (!fromMatch) {
            continue;
        }

        const objectName = fromMatch[1];
        const selectMatch = query.match(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i);

        if (!selectMatch) {
            continue;
        }

        const selectClause = selectMatch[1];

        // 1) Relationship-qualified fields: Relationship__r.Field__c
        //    → Relationship__c.Field__c (not FROMObject.Field__c).
        for (const match of selectClause.matchAll(
            /\b([A-Za-z0-9_]+__r)\.([A-Za-z0-9_]+__c)\b/g
        )) {
            const relationshipName = match[1];
            const fieldApiName = match[2];
            const relatedObjectApiName = relationshipName.replace(
                /__r$/i,
                '__c'
            );
            const qualified = `${relatedObjectApiName}.${fieldApiName}`;
            qualifiedFields.add(qualified);
        }

        // 2) Bare SELECT fields (exclude relationship-qualified segments so
        //    Price__c from Experience__r.Price__c is not attached to FROM).
        const selectWithoutRelationships = selectClause.replace(
            /\b[A-Za-z0-9_]+__r\.[A-Za-z0-9_]+__c\b/g,
            ' '
        );
        const fieldTokens =
            selectWithoutRelationships.match(/\b[A-Za-z0-9_]+__c\b/g) || [];

        for (const fieldName of fieldTokens) {
            if (fieldName !== objectName) {
                const qualified = `${objectName}.${fieldName}`;
                qualifiedFields.add(qualified);
            }
        }
    }

    return qualifiedFields;
}

function classifyCustomObjectsAndFields(cleanedContent) {
    const objectNames = extractObjectContextNames(cleanedContent);
    const customObjects = [];
    // Salesforce CustomField identity is always ObjectApiName.FieldApiName.
    // Never emit bare __c field tokens — that loses parent context.
    const customFields = new Set();

    // 1) Preserve Object__c.Field__c references as fully qualified identities.
    for (const match of cleanedContent.matchAll(
        /\b([A-Za-z0-9_]+__c)\.([A-Za-z0-9_]+__c)\b/g
    )) {
        const objectApiName = match[1];
        const fieldApiName = match[2];
        const qualified = `${objectApiName}.${fieldApiName}`;
        customFields.add(qualified);
    }

    // 2) Qualify variable.Field__c using declared variable object types.
    const variableTypes = extractVariableObjectTypes(cleanedContent);

    for (const match of cleanedContent.matchAll(
        /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+__c)\b/g
    )) {
        const receiver = match[1];
        const fieldName = match[2];

        // Object__c.Field__c already handled above.
        if (/__c$/i.test(receiver)) {
            continue;
        }

        const objectType = variableTypes.get(receiver);

        if (objectType) {
            const qualified = `${objectType}.${fieldName}`;
            customFields.add(qualified);
        }
    }

    // 3) Qualify SOQL SELECT fields with the FROM object.
    for (const qualifiedField of extractSoqlQualifiedFields(cleanedContent)) {
        customFields.add(qualifiedField);
    }

    // 4) Remaining __c tokens with object context are CustomObjects.
    //    Unqualified __c tokens are NOT CustomFields (invalid identity).
    const allTokens = uniqueSorted(
        cleanedContent.match(/\b[A-Za-z0-9_]+__c\b/g) || []
    );

    allTokens.forEach((token) => {
        if (objectNames.has(token)) {
            customObjects.push(token);
        }
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

function analyzeApexContent(content, currentClassName) {
    const cleanedContent = stripLiteralsAndComments(content);
    const internalDeclarations = getInternalTypeDeclarations(content);
    const outerClassName = currentClassName || getCurrentClassName(content);
    const normalizedOuterClassName = normalizeApexIdentifier(outerClassName);

    const internalTypesToExclude = internalDeclarations.filter(
        (name) =>
            normalizeApexIdentifier(name) !== normalizedOuterClassName
    );

    const { customObjects: objectTokens, customFields } =
        classifyCustomObjectsAndFields(cleanedContent);

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
        .replace(/\b[A-Za-z0-9_]+__r\./g, '');

    const classRefs =
        contentForClassRefs.match(
            /\b[A-Z][A-Za-z0-9_]+\./g
        ) || [];

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

    const apexClasses = uniqueSorted([
        ...classRefs.map((ref) => ref.replace(/\.$/, '')),
        ...constructorMatches.map((match) =>
            match.replace(/^new\s+/, '')
        )
    ].filter(
        (name) =>
            !excludedClasses.has(normalizeApexIdentifier(name)) &&
            !isSalesforceMetadataToken(name) &&
            !isRelationshipReferenceToken(name)
    ));

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
        )
    };
}

module.exports = {
    analyzeApexContent,
    getCurrentClassName,
    extractCustomMetadataTypes,
    extractCustomMetadataRecords,
    SYSTEM_CLASSES
};
