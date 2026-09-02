/**
 * Bounded formula prerequisite discovery for structurally required CustomFields.
 *
 * Inspects formula fields discovered via structuralActionOverrideField only.
 * Emits one-hop cross-object CustomField prerequisites — never parent objects
 * or unrelated metadata.
 */

const {
    collectExpressionReferences,
    CATEGORIES
} = require('../../formulaCompatibility.service');
const {
    DISCOVERY_METHOD: STRUCTURAL_ACTION_OVERRIDE_FIELD_DISCOVERY_METHOD
} = require('./structuralActionOverrideField.discoverer');

const DISCOVERY_METHOD = 'structuralFormulaRelatedField';
const DISCOVERER_ID = 'StructuralFormulaRelatedFieldDiscoverer';
const EXPANSION_POLICY = 'PREREQUISITE_ONLY';

function extractXmlTagValue(xml, tagName) {
    if (!xml || !tagName) {
        return null;
    }

    const pattern = new RegExp(
        `<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(xml).match(pattern);

    return match ? match[1].trim() : null;
}

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function parseQualifiedFieldName(qualifiedName) {
    const normalized = String(qualifiedName || '').trim();

    if (!normalized.includes('.')) {
        return null;
    }

    const separatorIndex = normalized.indexOf('.');
    const objectApiName = normalized.slice(0, separatorIndex).trim();
    const fieldApiName = normalized.slice(separatorIndex + 1).trim();

    if (!objectApiName || !fieldApiName) {
        return null;
    }

    return { objectApiName, fieldApiName };
}

function resolveCustomFieldRepoPath(qualifiedName, repoFiles) {
    const parsed = parseQualifiedFieldName(qualifiedName);

    if (!parsed) {
        return null;
    }

    const expectedEnding = `/objects/${parsed.objectApiName}/fields/${parsed.fieldApiName}.field-meta.xml`;

    if (Array.isArray(repoFiles) && repoFiles.length) {
        const match = repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedEnding));

        if (match) {
            return match;
        }
    }

    return `force-app/main/default${expectedEnding}`;
}

function isFormulaCustomField(fieldXml) {
    const fieldType = extractXmlTagValue(fieldXml, 'type');
    const formula = extractXmlTagValue(fieldXml, 'formula');

    return String(fieldType || '') === 'Formula' || Boolean(formula);
}

function extractCrossObjectFormulaPrerequisites(fieldXml, ownerObjectApiName) {
    const prerequisites = [];
    const seen = new Set();

    for (const ref of collectExpressionReferences(fieldXml, ownerObjectApiName)) {
        if (!ref?.qualifiedName || !ref.isCustom || ref.isStandard) {
            continue;
        }

        const parsed = parseQualifiedFieldName(ref.qualifiedName);

        if (!parsed || parsed.objectApiName === ownerObjectApiName) {
            continue;
        }

        if (
            ref.category !== CATEGORIES.MISSING_RELATION &&
            ref.category !== CATEGORIES.MISSING_FIELD
        ) {
            continue;
        }

        if (seen.has(ref.qualifiedName)) {
            continue;
        }

        seen.add(ref.qualifiedName);
        prerequisites.push({
            qualifiedName: ref.qualifiedName,
            objectApiName: parsed.objectApiName,
            fieldApiName: parsed.fieldApiName,
            relationshipRef: ref.relationshipRef || null,
            category: ref.category
        });
    }

    return prerequisites;
}

function createStructuralFormulaRelatedFieldRecord({
    qualifiedName,
    sourceFormulaFieldName,
    sourceMetadata,
    relationshipRef,
    depth
}) {
    const parsed = parseQualifiedFieldName(qualifiedName);

    return {
        name: qualifiedName,
        metadataType: 'CustomField',
        type: 'CustomField',
        relationship: 'FormulaRelatedField',
        sourceMetadata: sourceFormulaFieldName,
        sourceField: parsed?.fieldApiName || null,
        origin: sourceMetadata || null,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        expansionPolicy: EXPANSION_POLICY,
        required: true,
        selected: true,
        depth,
        deployable: true,
        blocking: true,
        reason: relationshipRef
            ? `Formula field ${sourceFormulaFieldName} references ${qualifiedName} via ${relationshipRef}.`
            : `Formula field ${sourceFormulaFieldName} references ${qualifiedName}.`
    };
}

/**
 * Discover bounded formula-related CustomField prerequisites for structural
 * actionOverride fields.
 *
 * @returns {Promise<{ dependencies: object[], closureCandidates: object[], warnings: string[], filesScanned: number }>}
 */
async function discoverStructuralFormulaRelatedFields({
    structuralFieldDependencies = [],
    readRepoFile,
    repoFiles
} = {}) {
    const dependencies = [];
    const closureCandidates = [];
    const warnings = [];
    const seenQualifiedNames = new Set();
    let filesScanned = 0;

    if (!readRepoFile) {
        return { dependencies, closureCandidates, warnings, filesScanned };
    }

    for (const dependency of structuralFieldDependencies) {
        if (
            dependency?.discoveryMethod !==
            STRUCTURAL_ACTION_OVERRIDE_FIELD_DISCOVERY_METHOD
        ) {
            continue;
        }

        const qualifiedName =
            dependency?.name ||
            dependency?.metadataName ||
            null;
        const parsed = parseQualifiedFieldName(qualifiedName);

        if (!parsed) {
            continue;
        }

        const fieldPath =
            dependency?.filePath ||
            resolveCustomFieldRepoPath(qualifiedName, repoFiles);

        if (!fieldPath) {
            warnings.push(
                `CustomField metadata path not found for structural formula scan of ${qualifiedName}.`
            );
            continue;
        }

        let fieldXml;

        try {
            fieldXml = await readRepoFile(fieldPath);
            filesScanned += 1;
        } catch (error) {
            warnings.push(
                `Unable to read CustomField metadata ${fieldPath} for structural formula scan: ${
                    error?.message || 'unknown error'
                }`
            );
            continue;
        }

        if (!isFormulaCustomField(fieldXml)) {
            continue;
        }

        for (const prerequisite of extractCrossObjectFormulaPrerequisites(
            fieldXml,
            parsed.objectApiName
        )) {
            if (seenQualifiedNames.has(prerequisite.qualifiedName)) {
                continue;
            }

            seenQualifiedNames.add(prerequisite.qualifiedName);

            const record = createStructuralFormulaRelatedFieldRecord({
                qualifiedName: prerequisite.qualifiedName,
                sourceFormulaFieldName: qualifiedName,
                sourceMetadata: dependency?.sourceMetadata || null,
                relationshipRef: prerequisite.relationshipRef,
                depth:
                    dependency?.depth != null ? dependency.depth + 1 : 2
            });

            dependencies.push(record);
            closureCandidates.push({
                metadataType: 'CustomField',
                metadataName: prerequisite.qualifiedName,
                deployable: true
            });
        }
    }

    return { dependencies, closureCandidates, warnings, filesScanned };
}

module.exports = {
    DISCOVERY_METHOD,
    DISCOVERER_ID,
    EXPANSION_POLICY,
    discoverStructuralFormulaRelatedFields,
    extractCrossObjectFormulaPrerequisites,
    isFormulaCustomField,
    parseQualifiedFieldName,
    resolveCustomFieldRepoPath
};
