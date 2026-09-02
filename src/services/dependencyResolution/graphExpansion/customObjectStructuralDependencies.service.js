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

    for (const flexiPageName of extractFlexiPagesFromActionOverrides(
        objectXml
    )) {
        relationships.push(
            createActionOverrideFlexiPageRecord({
                flexiPageName,
                sourceMetadata: objectApiName,
                depth
            })
        );
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
    createActionOverrideFlexiPageRecord
};
