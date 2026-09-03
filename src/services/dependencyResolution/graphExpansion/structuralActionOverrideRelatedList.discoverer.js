/**
 * Bounded dynamic related-list prerequisites for structural ActionOverride
 * FlexiPages. Resolves relationship-defining CustomFields only — never broad
 * child-object expansion.
 */

const {
    resolveFlexiPageFilePath
} = require('./customObjectStructuralDependencies.service');
const { METADATA_ORIGINS } = require('../metadataGraphOrigin.model');

const DISCOVERY_METHOD = 'structuralActionOverrideRelatedList';
const DISCOVERER_ID = 'StructuralActionOverrideRelatedListDiscoverer';
const EXPANSION_POLICY = 'PREREQUISITE_ONLY';
const ACTION_OVERRIDE_RELATIONSHIP = 'ActionOverride';
const ACTION_OVERRIDE_DISCOVERY_METHOD = 'actionOverrides';
const CLOSURE_ELIGIBLE_ORIGINS = new Set([
    METADATA_ORIGINS.DIRECT_DEPENDENCY,
    METADATA_ORIGINS.RELATIONSHIP_TARGET
]);
const ACTION_OVERRIDE_RELATED_LIST_RELATIONSHIP = 'ActionOverrideRelatedList';
const DYNAMIC_RELATED_LIST_COMPONENT = 'lst:dynamicRelatedList';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function extractXmlTagValue(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(content || '').match(pattern);

    return match ? match[1].trim() : null;
}

function parseRelationshipNameFromRelatedListApiName(relatedListApiName) {
    const normalized = String(relatedListApiName || '').trim();

    if (!normalized) {
        return null;
    }

    if (normalized.endsWith('__r')) {
        return normalized.slice(0, -3);
    }

    return normalized;
}

function extractDynamicRelatedListReferences(flexiPageXml) {
    const references = [];
    const componentBlocks = String(flexiPageXml).matchAll(
        /<componentInstance\b[^>]*>([\s\S]*?)<\/componentInstance>/gi
    );

    for (const match of componentBlocks) {
        const block = match[1] || '';
        const componentName = extractXmlTagValue(block, 'componentName');

        if (componentName !== DYNAMIC_RELATED_LIST_COMPONENT) {
            continue;
        }

        const propertyBlocks = block.matchAll(
            /<componentInstanceProperties\b[^>]*>([\s\S]*?)<\/componentInstanceProperties>/gi
        );

        let relatedListApiName = null;

        for (const propertyMatch of propertyBlocks) {
            const propertyBlock = propertyMatch[1] || '';
            const propertyName = extractXmlTagValue(propertyBlock, 'name');
            const propertyValue = extractXmlTagValue(propertyBlock, 'value');

            if (propertyName === 'relatedListApiName' && propertyValue) {
                relatedListApiName = propertyValue;
            }
        }

        if (relatedListApiName) {
            references.push({ relatedListApiName });
        }
    }

    return references;
}

function parseCustomFieldPath(fieldPath) {
    const normalized = normalizePath(fieldPath);
    const match = normalized.match(
        /\/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/i
    );

    if (!match) {
        return null;
    }

    return {
        childObjectApiName: match[1],
        fieldApiName: match[2]
    };
}

function listCustomFieldRepoPaths(repoFiles = []) {
    return repoFiles
        .map(normalizePath)
        .filter((repoFile) =>
            /\/objects\/[^/]+\/fields\/[^/]+\.field-meta\.xml$/i.test(repoFile)
        );
}

async function resolveRelationshipDefiningField({
    relationshipName,
    referenceTo,
    repoFiles,
    readRepoFile
}) {
    if (!relationshipName || !referenceTo || !readRepoFile) {
        return null;
    }

    for (const fieldPath of listCustomFieldRepoPaths(repoFiles)) {
        let fieldXml;

        try {
            fieldXml = await readRepoFile(fieldPath);
        } catch (error) {
            continue;
        }

        const fieldRelationshipName = extractXmlTagValue(
            fieldXml,
            'relationshipName'
        );
        const fieldReferenceTo = extractXmlTagValue(fieldXml, 'referenceTo');

        if (
            fieldRelationshipName !== relationshipName ||
            fieldReferenceTo !== referenceTo
        ) {
            continue;
        }

        const parsedPath = parseCustomFieldPath(fieldPath);

        if (!parsedPath) {
            continue;
        }

        return {
            childObjectApiName: parsedPath.childObjectApiName,
            fieldApiName: parsedPath.fieldApiName,
            qualifiedName: `${parsedPath.childObjectApiName}.${parsedPath.fieldApiName}`,
            fieldPath
        };
    }

    return null;
}

function isStructuralActionOverrideFlexiPageDependency(dependency) {
    const metadataType = dependency?.metadataType || dependency?.type;

    if (metadataType !== 'FlexiPage') {
        return false;
    }

    if (dependency?.relationship !== ACTION_OVERRIDE_RELATIONSHIP) {
        return false;
    }

    if (dependency?.discoveryMethod !== ACTION_OVERRIDE_DISCOVERY_METHOD) {
        return false;
    }

    return CLOSURE_ELIGIBLE_ORIGINS.has(dependency?.origin);
}

function createStructuralActionOverrideRelatedListFieldRecord({
    qualifiedName,
    flexiPageName,
    parentSobjectType,
    relatedListApiName,
    fieldPath,
    depth,
    origin = null
}) {
    const fieldApiName = qualifiedName.includes('.')
        ? qualifiedName.split('.').pop()
        : null;

    return {
        name: qualifiedName,
        metadataType: 'CustomField',
        type: 'CustomField',
        relationship: ACTION_OVERRIDE_RELATED_LIST_RELATIONSHIP,
        sourceMetadata: flexiPageName,
        sourceField: relatedListApiName,
        sobjectType: parentSobjectType,
        origin: origin || flexiPageName,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        expansionPolicy: EXPANSION_POLICY,
        required: true,
        selected: true,
        depth,
        deployable: true,
        blocking: true,
        filePath: fieldPath || null,
        reason: `Relationship field ${qualifiedName} required by structural FlexiPage related list ${relatedListApiName} on ${flexiPageName}.`
    };
}

function createStructuralActionOverrideRelatedListObjectRecord({
    childObjectApiName,
    flexiPageName,
    depth,
    origin = null
}) {
    return {
        name: childObjectApiName,
        metadataType: 'CustomObject',
        type: 'CustomObject',
        relationship: ACTION_OVERRIDE_RELATED_LIST_RELATIONSHIP,
        sourceMetadata: flexiPageName,
        origin: origin || flexiPageName,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        expansionPolicy: EXPANSION_POLICY,
        required: true,
        selected: true,
        depth,
        deployable: true,
        blocking: true,
        reason: `CustomObject ${childObjectApiName} shell required by structural FlexiPage related list on ${flexiPageName}.`
    };
}

async function discoverRelatedListsForFlexiPage({
    flexiPageName,
    parentSobjectType,
    flexiPageXml,
    repoFiles,
    readRepoFile,
    depth,
    origin,
    seenFieldKeys,
    seenObjectKeys,
    relationships,
    closureCandidates,
    warnings
}) {
    const sobjectType = extractXmlTagValue(flexiPageXml, 'sobjectType');

    if (!sobjectType || sobjectType !== parentSobjectType) {
        return;
    }

    for (const relatedListReference of extractDynamicRelatedListReferences(
        flexiPageXml
    )) {
        const relationshipName = parseRelationshipNameFromRelatedListApiName(
            relatedListReference.relatedListApiName
        );

        if (!relationshipName) {
            continue;
        }

        const resolvedField = await resolveRelationshipDefiningField({
            relationshipName,
            referenceTo: parentSobjectType,
            repoFiles,
            readRepoFile
        });

        if (!resolvedField) {
            warnings.push(
                `Unable to resolve relationship-defining CustomField for ${relatedListReference.relatedListApiName} on ${flexiPageName} (${parentSobjectType}).`
            );
            continue;
        }

        if (seenFieldKeys.has(resolvedField.qualifiedName)) {
            continue;
        }

        seenFieldKeys.add(resolvedField.qualifiedName);
        relationships.push(
            createStructuralActionOverrideRelatedListFieldRecord({
                qualifiedName: resolvedField.qualifiedName,
                flexiPageName,
                parentSobjectType,
                relatedListApiName: relatedListReference.relatedListApiName,
                fieldPath: resolvedField.fieldPath,
                depth,
                origin
            })
        );
        closureCandidates.push({
            metadataType: 'CustomField',
            metadataName: resolvedField.qualifiedName,
            deployable: true
        });

        if (!seenObjectKeys.has(resolvedField.childObjectApiName)) {
            seenObjectKeys.add(resolvedField.childObjectApiName);
            relationships.push(
                createStructuralActionOverrideRelatedListObjectRecord({
                    childObjectApiName: resolvedField.childObjectApiName,
                    flexiPageName,
                    depth,
                    origin
                })
            );
            closureCandidates.push({
                metadataType: 'CustomObject',
                metadataName: resolvedField.childObjectApiName,
                deployable: true
            });
        }
    }
}

/**
 * Discover related-list prerequisites from structural actionOverride FlexiPages
 * for a MasterDetail parent object during graph expansion.
 */
async function discoverStructuralActionOverrideFlexiPageRelatedLists({
    objectApiName,
    actionOverrideFlexiPages,
    repoFiles,
    readRepoFile,
    depth = 1
}) {
    const relationships = [];
    const closureCandidates = [];
    const warnings = [];
    const seenFieldKeys = new Set();
    const seenObjectKeys = new Set();
    let filesScanned = 0;

    if (
        !objectApiName ||
        !Array.isArray(actionOverrideFlexiPages) ||
        !Array.isArray(repoFiles) ||
        !readRepoFile
    ) {
        return { relationships, closureCandidates, warnings, filesScanned };
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
                `FlexiPage metadata file not found for structural action override related list scan of ${flexiPageName} on ${objectApiName}.`
            );
            continue;
        }

        let flexiPageXml;

        try {
            flexiPageXml = await readRepoFile(filePath);
            filesScanned += 1;
        } catch (error) {
            warnings.push(
                `Unable to read FlexiPage metadata ${filePath} for structural action override related list scan on ${objectApiName}: ${
                    error?.message || 'unknown error'
                }`
            );
            continue;
        }

        await discoverRelatedListsForFlexiPage({
            flexiPageName,
            parentSobjectType: objectApiName,
            flexiPageXml,
            repoFiles,
            readRepoFile,
            depth,
            origin: flexiPageName,
            seenFieldKeys,
            seenObjectKeys,
            relationships,
            closureCandidates,
            warnings
        });
    }

    return { relationships, closureCandidates, warnings, filesScanned };
}

/**
 * Discover related-list prerequisites from structural actionOverride FlexiPages
 * already present in enriched dependencies.
 */
async function discoverStructuralActionOverrideRelatedLists({
    structuralFlexiPageDependencies = [],
    readRepoFile,
    repoFiles
} = {}) {
    const dependencies = [];
    const closureCandidates = [];
    const warnings = [];
    const seenFieldKeys = new Set();
    const seenObjectKeys = new Set();
    let filesScanned = 0;

    if (!readRepoFile) {
        return { dependencies, closureCandidates, warnings, filesScanned };
    }

    for (const dependency of structuralFlexiPageDependencies) {
        if (!isStructuralActionOverrideFlexiPageDependency(dependency)) {
            continue;
        }

        const flexiPageName =
            dependency?.name || dependency?.metadataName || null;

        if (!flexiPageName) {
            continue;
        }

        const filePath =
            dependency?.filePath ||
            resolveFlexiPageFilePath(flexiPageName, repoFiles || []);

        if (!filePath) {
            warnings.push(
                `FlexiPage metadata path not found for structural related list scan of ${flexiPageName}.`
            );
            continue;
        }

        let flexiPageXml;

        try {
            flexiPageXml = await readRepoFile(filePath);
            filesScanned += 1;
        } catch (error) {
            warnings.push(
                `Unable to read FlexiPage metadata ${filePath} for structural related list scan: ${
                    error?.message || 'unknown error'
                }`
            );
            continue;
        }

        const parentSobjectType = extractXmlTagValue(flexiPageXml, 'sobjectType');

        if (!parentSobjectType) {
            warnings.push(
                `FlexiPage ${flexiPageName} is missing sobjectType; skipping structural related list scan.`
            );
            continue;
        }

        const relationships = [];

        await discoverRelatedListsForFlexiPage({
            flexiPageName,
            parentSobjectType,
            flexiPageXml,
            repoFiles: repoFiles || [],
            readRepoFile,
            depth:
                dependency?.depth != null ? dependency.depth + 1 : 2,
            origin: dependency?.origin || flexiPageName,
            seenFieldKeys,
            seenObjectKeys,
            relationships,
            closureCandidates,
            warnings
        });

        dependencies.push(...relationships);
    }

    return { dependencies, closureCandidates, warnings, filesScanned };
}

module.exports = {
    DISCOVERY_METHOD,
    DISCOVERER_ID,
    EXPANSION_POLICY,
    ACTION_OVERRIDE_RELATED_LIST_RELATIONSHIP,
    discoverStructuralActionOverrideFlexiPageRelatedLists,
    discoverStructuralActionOverrideRelatedLists,
    extractDynamicRelatedListReferences,
    isStructuralActionOverrideFlexiPageDependency,
    parseRelationshipNameFromRelatedListApiName,
    resolveRelationshipDefiningField
};
