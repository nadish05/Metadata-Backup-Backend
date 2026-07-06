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
    'SelectOption'
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

function classifyCustomObjectsAndFields(cleanedContent) {
    const allTokens = uniqueSorted(
        cleanedContent.match(/\b[A-Za-z0-9_]+__c\b/g) || []
    );

    const dottedFieldRefs =
        cleanedContent.match(
            /\b([A-Za-z0-9_]+__c)\.([A-Za-z0-9_]+__c)\b/g
        ) || [];

    const customFields = new Set(dottedFieldRefs);

    dottedFieldRefs.forEach((fieldRef) => {
        customFields.add(fieldRef.split('.')[1]);
    });

    const dotFieldNames = (
        cleanedContent.match(/\.([A-Za-z0-9_]+__c)\b/g) || []
    ).map((match) => match.slice(1));

    dotFieldNames.forEach((name) => customFields.add(name));

    const objectNames = extractObjectContextNames(cleanedContent);
    const customObjects = [];

    allTokens.forEach((token) => {
        if (objectNames.has(token)) {
            customObjects.push(token);
            return;
        }

        customFields.add(token);
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

function analyzeApexContent(content, currentClassName) {
    const cleanedContent = stripLiteralsAndComments(content);
    const internalDeclarations = getInternalTypeDeclarations(content);
    const outerClassName = currentClassName || getCurrentClassName(content);

    const internalTypesToExclude = new Set(
        internalDeclarations.filter((name) => name !== outerClassName)
    );

    const { customObjects, customFields } =
        classifyCustomObjectsAndFields(cleanedContent);

    const relationshipReferences =
        classifyRelationshipReferences(cleanedContent);

    const customMetadata =
        cleanedContent.match(
            /\b[A-Za-z0-9_]+__mdt\b/g
        ) || [];

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
        ...SYSTEM_CLASSES,
        ...internalTypesToExclude,
        ...(outerClassName ? [outerClassName] : [])
    ]);

    const apexClasses = uniqueSorted([
        ...classRefs.map((ref) => ref.replace(/\.$/, '')),
        ...constructorMatches.map((match) =>
            match.replace(/^new\s+/, '')
        )
    ].filter(
        (name) =>
            !excludedClasses.has(name) &&
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
    getCurrentClassName
};
