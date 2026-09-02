/**
 * Narrow structural dependencies for non-enumerable CustomObjects.
 * Does not run broad relationship-registry or deployment-review enumeration.
 */

const customObjectRelationshipDiscoverer = require('../discoverers/customObjectRelationship.discoverer');
const {
    extractFlexiPagesFromActionOverrides,
    resolveObjectMetaXmlPath
} = require('../discoverers/customObjectActionOverride.discoverer');

const ACTION_OVERRIDE_DISCOVERY_METHOD = 'actionOverrides';
const ACTION_OVERRIDE_RELATIONSHIP = 'ActionOverride';
const LAYOUT_REFERENCE_DISCOVERY_METHOD = 'layoutReference';
const LAYOUT_PARENT_OBJECT_REFERENCE_TYPE = 'ParentObject';
const FLEXIPAGE_SUFFIX = '.flexipage-meta.xml';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function resolveFlexiPageFilePath(flexiPageName, repoFiles) {
    if (!flexiPageName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedEnding = `/flexipages/${flexiPageName}${FLEXIPAGE_SUFFIX}`;

    return (
        repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedEnding)) || null
    );
}

function extractXmlTagValue(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(content || '').match(pattern);

    return match ? match[1].trim() : null;
}

async function isStructuralActionOverrideFlexiPageForObject({
    flexiPageName,
    objectApiName,
    repoFiles,
    readRepoFile,
    warnings
}) {
    const filePath = resolveFlexiPageFilePath(flexiPageName, repoFiles);

    if (!filePath) {
        warnings.push(
            `FlexiPage metadata file not found for structural action override ${flexiPageName} on ${objectApiName}.`
        );
        return { matches: false, filesScanned: 0 };
    }

    try {
        const flexiPageXml = await readRepoFile(filePath);
        const sobjectType = extractXmlTagValue(flexiPageXml, 'sobjectType');

        if (!sobjectType) {
            warnings.push(
                `FlexiPage ${flexiPageName} is missing sobjectType; skipping structural action override for ${objectApiName}.`
            );
            return { matches: false, filesScanned: 1 };
        }

        return {
            matches: sobjectType === objectApiName,
            filesScanned: 1
        };
    } catch (error) {
        warnings.push(
            `Unable to read FlexiPage metadata ${filePath} for structural action override validation on ${objectApiName}: ${
                error?.message || 'unknown error'
            }`
        );
        return { matches: false, filesScanned: 0 };
    }
}

function shouldSkipStructuralActionOverrideFlexiPages(scanTarget) {
    const referenceType =
        scanTarget?.referenceType || scanTarget?.relationship || null;

    return (
        scanTarget?.discoveryMethod === LAYOUT_REFERENCE_DISCOVERY_METHOD &&
        referenceType === LAYOUT_PARENT_OBJECT_REFERENCE_TYPE
    );
}

function createActionOverrideFlexiPageRecord({
    flexiPageName,
    sourceMetadata,
    depth
}) {
    return {
        name: flexiPageName,
        metadataType: 'FlexiPage',
        type: 'FlexiPage',
        relationship: ACTION_OVERRIDE_RELATIONSHIP,
        sourceMetadata,
        sourceField: null,
        discoveredBy: 'CustomObjectStructuralDependencies',
        discoveryMethod: ACTION_OVERRIDE_DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        reason:
            'FlexiPage action override discovered from CustomObject metadata.'
    };
}

/**
 * Discover deploy-invariant dependencies for a secondary CustomObject:
 * - actionOverrides FlexiPages
 * - MasterDetail owning fields when sharing is ControlledByParent
 *
 * @returns {Promise<{ relationships: object[], warnings: string[], filesScanned: number }>}
 */
async function discoverStructuralCustomObjectDependencies({
    objectApiName,
    scanTarget,
    repoFiles,
    readRepoFile,
    depth = 1
}) {
    const relationships = [];
    const warnings = [];
    let filesScanned = 0;

    if (!objectApiName || !Array.isArray(repoFiles) || !readRepoFile) {
        return { relationships, warnings, filesScanned };
    }

    const objectMetaPath = resolveObjectMetaXmlPath(scanTarget, repoFiles);

    if (!objectMetaPath) {
        warnings.push(
            `CustomObject metadata file not found for structural scan of ${objectApiName}.`
        );
        return { relationships, warnings, filesScanned };
    }

    let objectXml;

    try {
        objectXml = await readRepoFile(objectMetaPath);
        filesScanned += 1;
    } catch (error) {
        warnings.push(
            `Unable to read CustomObject metadata ${objectMetaPath} for structural scan: ${
                error?.message || 'unknown error'
            }`
        );
        return { relationships, warnings, filesScanned };
    }

    if (!shouldSkipStructuralActionOverrideFlexiPages(scanTarget)) {
        for (const flexiPageName of extractFlexiPagesFromActionOverrides(
            objectXml
        )) {
            const flexiPageMatch =
                await isStructuralActionOverrideFlexiPageForObject({
                    flexiPageName,
                    objectApiName,
                    repoFiles,
                    readRepoFile,
                    warnings
                });

            filesScanned += flexiPageMatch.filesScanned || 0;

            if (!flexiPageMatch.matches) {
                continue;
            }

            relationships.push(
                createActionOverrideFlexiPageRecord({
                    flexiPageName,
                    sourceMetadata: objectApiName,
                    depth
                })
            );
        }
    }

    const masterDetailFields =
        await customObjectRelationshipDiscoverer.discoverControlledByParentMasterDetailOwningFields(
            {
                objectApiName,
                objectXml,
                repoFiles,
                readRepoFile,
                depth
            }
        );

    for (const fieldRelationship of masterDetailFields) {
        filesScanned += 1;
    }

    relationships.push(...masterDetailFields);

    return { relationships, warnings, filesScanned };
}

module.exports = {
    discoverStructuralCustomObjectDependencies,
    createActionOverrideFlexiPageRecord,
    isStructuralActionOverrideFlexiPageForObject,
    shouldSkipStructuralActionOverrideFlexiPages,
    resolveFlexiPageFilePath
};
