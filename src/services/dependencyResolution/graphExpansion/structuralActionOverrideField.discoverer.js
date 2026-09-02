/**
 * Narrow FlexiPage field prerequisites for structural MasterDetail parent
 * actionOverride pages. Does not invoke flexiPageReferenceDiscoverer.
 */

const {
    isDeployableField,
    isSalesforceSystemField
} = require('../../../utils/salesforceSystemFields.util');
const {
    resolveFlexiPageFilePath
} = require('./customObjectStructuralDependencies.service');

const DISCOVERY_METHOD = 'structuralActionOverrideField';
const ACTION_OVERRIDE_RELATIONSHIP = 'ActionOverride';
const DISCOVERER_ID = 'CustomObjectStructuralDependencies';

function extractXmlTagValue(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(content || '').match(pattern);

    return match ? match[1].trim() : null;
}

function extractAllXmlTagValues(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'gi'
    );
    const values = [];
    let match;

    while ((match = pattern.exec(String(content || ''))) !== null) {
        const value = String(match[1] || '').trim();

        if (value) {
            values.push(value);
        }
    }

    return values;
}

function parseRecordFieldApiName(rawValue) {
    if (!rawValue) {
        return null;
    }

    let value = String(rawValue).trim();
    const formulaMatch = value.match(/^\{!\s*Record\.(.+?)\s*\}$/i);

    if (formulaMatch) {
        value = `Record.${formulaMatch[1]}`;
    }

    if (!/^Record\./i.test(value)) {
        return null;
    }

    const withoutPrefix = value.replace(/^Record\./i, '');
    const parts = withoutPrefix.split('.');
    const fieldApiName = parts[parts.length - 1];

    if (!fieldApiName || parts.length > 2) {
        return null;
    }

    if (parts.length === 2 && /__r$/i.test(parts[0])) {
        return null;
    }

    return fieldApiName;
}

function extractStructuralActionOverrideFieldApiNames(flexiPageXml) {
    const fieldNames = new Set();

    for (const fieldItem of extractAllXmlTagValues(flexiPageXml, 'fieldItem')) {
        const fieldApiName = parseRecordFieldApiName(fieldItem);

        if (fieldApiName) {
            fieldNames.add(fieldApiName);
        }
    }

    const expressionPattern =
        /\{!\s*Record\.([A-Za-z][A-Za-z0-9_]*)\s*\}/gi;
    let match;
    const xml = String(flexiPageXml || '');

    while ((match = expressionPattern.exec(xml)) !== null) {
        const fieldApiName = match[1];

        if (fieldApiName) {
            fieldNames.add(fieldApiName);
        }
    }

    return [...fieldNames];
}

function createStructuralActionOverrideFieldRecord({
    flexiPageName,
    objectApiName,
    fieldApiName,
    depth
}) {
    return {
        name: `${objectApiName}.${fieldApiName}`,
        metadataType: 'CustomField',
        type: 'CustomField',
        relationship: 'Field',
        sourceMetadata: flexiPageName,
        sourceField: fieldApiName,
        sobjectType: objectApiName,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        deployable: true,
        blocking: true,
        reason: `CustomField referenced by structural FlexiPage action override ${flexiPageName}.`
    };
}

/**
 * Discover CustomField prerequisites referenced by structural actionOverride
 * FlexiPages for a MasterDetail parent object.
 *
 * @returns {Promise<{ relationships: object[], warnings: string[], filesScanned: number }>}
 */
async function discoverStructuralActionOverrideFlexiPageFields({
    objectApiName,
    actionOverrideFlexiPages,
    repoFiles,
    readRepoFile,
    depth = 1
}) {
    const relationships = [];
    const warnings = [];
    const seenFieldKeys = new Set();
    let filesScanned = 0;

    if (
        !objectApiName ||
        !Array.isArray(actionOverrideFlexiPages) ||
        !Array.isArray(repoFiles) ||
        !readRepoFile
    ) {
        return { relationships, warnings, filesScanned };
    }

    for (const flexiPage of actionOverrideFlexiPages) {
        if (flexiPage?.relationship !== ACTION_OVERRIDE_RELATIONSHIP) {
            continue;
        }

        const flexiPageName = flexiPage?.name;

        if (!flexiPageName) {
            continue;
        }

        const filePath = resolveFlexiPageFilePath(flexiPageName, repoFiles);

        if (!filePath) {
            warnings.push(
                `FlexiPage metadata file not found for structural action override field scan of ${flexiPageName} on ${objectApiName}.`
            );
            continue;
        }

        let flexiPageXml;

        try {
            flexiPageXml = await readRepoFile(filePath);
            filesScanned += 1;
        } catch (error) {
            warnings.push(
                `Unable to read FlexiPage metadata ${filePath} for structural action override field scan on ${objectApiName}: ${
                    error?.message || 'unknown error'
                }`
            );
            continue;
        }

        const sobjectType = extractXmlTagValue(flexiPageXml, 'sobjectType');

        if (!sobjectType || sobjectType !== objectApiName) {
            continue;
        }

        for (const fieldApiName of extractStructuralActionOverrideFieldApiNames(
            flexiPageXml
        )) {
            if (
                isSalesforceSystemField(fieldApiName) ||
                !isDeployableField(fieldApiName)
            ) {
                continue;
            }

            const fieldKey = `${objectApiName}.${fieldApiName}`;

            if (seenFieldKeys.has(fieldKey)) {
                continue;
            }

            seenFieldKeys.add(fieldKey);
            relationships.push(
                createStructuralActionOverrideFieldRecord({
                    flexiPageName,
                    objectApiName,
                    fieldApiName,
                    depth
                })
            );
        }
    }

    return { relationships, warnings, filesScanned };
}

module.exports = {
    DISCOVERY_METHOD,
    discoverStructuralActionOverrideFlexiPageFields,
    extractStructuralActionOverrideFieldApiNames,
    parseRecordFieldApiName
};
