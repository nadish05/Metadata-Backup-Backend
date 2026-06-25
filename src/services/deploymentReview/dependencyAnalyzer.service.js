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
        /\b(?:public|global|private|with\s+sharing|without\s+sharing|inherited\s+sharing)\s+(?:virtual\s+|abstract\s+)?class\s+([A-Za-z0-9_]+)/
    );

    if (classMatch) {
        return classMatch[1];
    }

    const baseName = path.basename(filePath, path.extname(filePath));
    return baseName || null;
}

function getInnerClassNames(content) {
    const matches = content.match(
        /\b(?:public|private|protected)\s+class\s+([A-Za-z0-9_]+)/g
    ) || [];

    const outerClassMatch = content.match(
        /\b(?:public|global)\s+(?:virtual\s+|abstract\s+)?class\s+([A-Za-z0-9_]+)/
    );

    const outerClassName = outerClassMatch ? outerClassMatch[1] : null;

    return matches
        .map((match) => match.replace(/.*class\s+/, ''))
        .filter((name) => name !== outerClassName);
}

function uniqueSorted(values) {
    return [...new Set(values)].sort();
}

function isSalesforceMetadataToken(name) {
    return name.endsWith('__c') || name.endsWith('__mdt');
}

function analyzeApexContent(content, currentClassName) {
    const cleanedContent = stripLiteralsAndComments(content);
    const innerClasses = getInnerClassNames(content);

    const customFieldMatches =
        cleanedContent.match(
            /\b([A-Za-z0-9_]+__c)\.([A-Za-z0-9_]+__c)\b/g
        ) || [];

    const fieldOnlyNames = new Set(
        customFieldMatches.map((fieldRef) => fieldRef.split('.')[1])
    );

    const customObjects = (
        cleanedContent.match(
            /\b[A-Za-z0-9_]+__c\b/g
        ) || []
    ).filter((name) => !fieldOnlyNames.has(name));

    const customMetadata =
        cleanedContent.match(
            /\b[A-Za-z0-9_]+__mdt\b/g
        ) || [];

    const contentForClassRefs = cleanedContent.replace(
        /\bFlow\.Interview\.[A-Za-z0-9_]+\b/g,
        ''
    );

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
        ...innerClasses,
        ...(currentClassName ? [currentClassName] : [])
    ]);

    const apexClasses = uniqueSorted([
        ...classRefs.map((ref) => ref.replace(/\.$/, '')),
        ...constructorMatches.map((match) =>
            match.replace(/^new\s+/, '')
        )
    ].filter(
        (name) =>
            !excludedClasses.has(name) &&
            !isSalesforceMetadataToken(name)
    ));

    return {
        customObjects: uniqueSorted(customObjects),
        customFields: uniqueSorted(customFieldMatches),
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
