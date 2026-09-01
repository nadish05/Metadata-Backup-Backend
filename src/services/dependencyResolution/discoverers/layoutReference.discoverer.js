const path = require('path');

const { buildGraphNodeId } = require('../graphId');
const { parseLayoutMemberName } = require('../../../utils/layoutMemberName.util');
const {
    isSalesforceSystemField,
    isDeployableField
} = require('../../../utils/salesforceSystemFields.util');
const {
    parseCustomRelatedListReference,
    parseRelatedListDisplayField,
    parseLayoutCustomButtonReference,
    parseLayoutQuickActionReference,
    isStandardRelatedObjectToken,
    extractXmlBlocks,
    extractAllXmlTagValues
} = require('../../../utils/layoutDependencyParsing.util');

const LAYOUT_SUFFIX = '.layout-meta.xml';
const DISCOVERER_ID = 'LayoutReferenceDiscoverer';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function resolveLayoutName(item) {
    if (item?.metadataName) {
        return String(item.metadataName).trim();
    }

    if (item?.name) {
        return String(item.name).trim();
    }

    if (item?.filePath) {
        const baseName = path.posix.basename(normalizePath(item.filePath));

        if (baseName.endsWith(LAYOUT_SUFFIX)) {
            return baseName.slice(0, -LAYOUT_SUFFIX.length);
        }
    }

    return null;
}

function resolveLayoutFilePath(item, repoFiles) {
    if (
        item?.filePath &&
        normalizePath(item.filePath).endsWith(LAYOUT_SUFFIX)
    ) {
        return normalizePath(item.filePath);
    }

    const layoutName = resolveLayoutName(item);

    if (!layoutName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedEnding = `/layouts/${layoutName}${LAYOUT_SUFFIX}`;

    return (
        repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedEnding)) || null
    );
}

function createReference({
    name,
    metadataType,
    sourceMetadata,
    sourceElement,
    referenceType,
    depth,
    reason,
    deployable,
    blocking,
    sobjectType = null
}) {
    return {
        id: buildGraphNodeId(metadataType, name),
        name,
        metadataType,
        type: metadataType,
        sourceMetadata,
        sourceElement,
        referenceType,
        required: blocking !== false,
        selected: false,
        reason,
        depth,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: 'layoutReference',
        deployable: deployable === true,
        blocking: blocking === true,
        sobjectType,
        relationship: referenceType
    };
}

function discoverParentObjectReference(layoutMemberName, sourceMetadata, depth) {
    const parsed = parseLayoutMemberName(layoutMemberName);

    if (!parsed?.objectApiName) {
        return null;
    }

    return createReference({
        name: parsed.objectApiName,
        metadataType: 'CustomObject',
        sourceMetadata,
        sourceElement: layoutMemberName,
        referenceType: 'ParentObject',
        depth,
        reason: 'Parent object required by Page Layout.',
        deployable: true,
        blocking: true,
        sobjectType: parsed.objectApiName
    });
}

function extractLayoutItemFieldNames(layoutXml) {
    const fieldNames = [];

    for (const block of extractXmlBlocks(layoutXml, 'layoutItems')) {
        fieldNames.push(...extractAllXmlTagValues(block, 'field'));
    }

    return fieldNames;
}

function discoverLayoutItemFieldReferences(
    layoutXml,
    sourceMetadata,
    objectApiName,
    depth
) {
    const references = [];

    for (const fieldApiName of extractLayoutItemFieldNames(layoutXml)) {
        if (!fieldApiName || fieldApiName.includes('.')) {
            continue;
        }

        if (isSalesforceSystemField(fieldApiName)) {
            continue;
        }

        if (!isDeployableField(fieldApiName)) {
            continue;
        }

        const qualifiedName = `${objectApiName}.${fieldApiName}`;

        references.push(
            createReference({
                name: qualifiedName,
                metadataType: 'CustomField',
                sourceMetadata,
                sourceElement: fieldApiName,
                referenceType: 'Field',
                depth,
                reason: 'Custom field referenced by Page Layout.',
                deployable: true,
                blocking: true,
                sobjectType: objectApiName
            })
        );
    }

    return references;
}

function discoverRelatedListReferences(layoutXml, sourceMetadata, depth) {
    const references = [];

    for (const block of extractXmlBlocks(layoutXml, 'relatedLists')) {
        for (const relatedListValue of extractAllXmlTagValues(
            block,
            'relatedList'
        )) {
            const qualifiedField = parseCustomRelatedListReference(
                relatedListValue
            );

            if (qualifiedField) {
                references.push(
                    createReference({
                        name: qualifiedField,
                        metadataType: 'CustomField',
                        sourceMetadata,
                        sourceElement: relatedListValue,
                        referenceType: 'RelatedList',
                        depth,
                        reason:
                            'Custom related list lookup field referenced by Page Layout.',
                        deployable: true,
                        blocking: true,
                        sobjectType: qualifiedField.split('.')[0] || null
                    })
                );
            }
        }

        for (const displayField of extractAllXmlTagValues(block, 'fields')) {
            const qualifiedField =
                parseRelatedListDisplayField(displayField);

            if (!qualifiedField) {
                continue;
            }

            references.push(
                createReference({
                    name: qualifiedField,
                    metadataType: 'CustomField',
                    sourceMetadata,
                    sourceElement: displayField,
                    referenceType: 'RelatedListField',
                    depth,
                    reason:
                        'Custom related list column field referenced by Page Layout.',
                    deployable: true,
                    blocking: true,
                    sobjectType: qualifiedField.split('.')[0] || null
                })
            );
        }
    }

    return references;
}

function discoverCustomButtonReferences(
    layoutXml,
    sourceMetadata,
    objectApiName,
    depth
) {
    const references = [];

    for (const buttonName of extractAllXmlTagValues(layoutXml, 'customButtons')) {
        const qualifiedName = parseLayoutCustomButtonReference(
            buttonName,
            objectApiName
        );

        if (!qualifiedName) {
            continue;
        }

        references.push(
            createReference({
                name: qualifiedName,
                metadataType: 'WebLink',
                sourceMetadata,
                sourceElement: buttonName,
                referenceType: 'CustomButton',
                depth,
                reason: 'Custom button (WebLink) referenced by Page Layout.',
                deployable: true,
                blocking: true,
                sobjectType: objectApiName
            })
        );
    }

    return references;
}

function discoverQuickActionReferences(layoutXml, sourceMetadata, depth) {
    const references = [];

    for (const actionName of extractAllXmlTagValues(
        layoutXml,
        'quickActionName'
    )) {
        const qualifiedName = parseLayoutQuickActionReference(actionName);

        if (!qualifiedName) {
            continue;
        }

        references.push(
            createReference({
                name: qualifiedName,
                metadataType: 'QuickAction',
                sourceMetadata,
                sourceElement: actionName,
                referenceType: 'QuickAction',
                depth,
                reason: 'Quick Action referenced by Page Layout.',
                deployable: false,
                blocking: false
            })
        );
    }

    return references;
}

function discoverPlatformActionReferences(layoutXml, sourceMetadata, depth) {
    const references = [];

    for (const actionName of extractAllXmlTagValues(layoutXml, 'actionName')) {
        const qualifiedName = parseLayoutQuickActionReference(actionName);

        if (!qualifiedName) {
            continue;
        }

        references.push(
            createReference({
                name: qualifiedName,
                metadataType: 'QuickAction',
                sourceMetadata,
                sourceElement: actionName,
                referenceType: 'PlatformAction',
                depth,
                reason: 'Platform action referenced by Page Layout.',
                deployable: false,
                blocking: false
            })
        );
    }

    return references;
}

function discoverCustomConsoleComponentReferences(
    layoutXml,
    sourceMetadata,
    depth
) {
    const references = [];

    for (const block of extractXmlBlocks(layoutXml, 'customConsoleComponents')) {
        for (const componentName of extractAllXmlTagValues(block, 'name')) {
            if (!componentName || componentName.includes(':')) {
                continue;
            }

            if (!/__c$/i.test(componentName)) {
                continue;
            }

            references.push(
                createReference({
                    name: componentName,
                    metadataType: 'LightningComponentBundle',
                    sourceMetadata,
                    sourceElement: componentName,
                    referenceType: 'ConsoleComponent',
                    depth,
                    reason:
                        'Console component referenced by Page Layout (deferred validation).',
                    deployable: false,
                    blocking: false
                })
            );
        }
    }

    return references;
}

function discoverRelatedObjectReferences(
    layoutXml,
    sourceMetadata,
    objectApiName,
    depth
) {
    const references = [];

    for (const relatedObject of extractAllXmlTagValues(
        layoutXml,
        'relatedObjects'
    )) {
        if (isStandardRelatedObjectToken(relatedObject)) {
            continue;
        }

        if (!isDeployableField(relatedObject)) {
            continue;
        }

        references.push(
            createReference({
                name: `${objectApiName}.${relatedObject}`,
                metadataType: 'CustomField',
                sourceMetadata,
                sourceElement: relatedObject,
                referenceType: 'RelatedObject',
                depth,
                reason:
                    'Custom related object field referenced by Page Layout.',
                deployable: true,
                blocking: true,
                sobjectType: objectApiName
            })
        );
    }

    return references;
}

function dedupeReferences(references) {
    const map = new Map();

    for (const reference of references) {
        const key = reference.id || `${reference.metadataType}:${reference.name}`;

        if (!map.has(key)) {
            map.set(key, reference);
        }
    }

    return [...map.values()];
}

/**
 * Discover deploy-relevant metadata references inside Layout XML.
 */
const layoutReferenceDiscoverer = {
    id: DISCOVERER_ID,

    async discover({ selectedMetadata, repoFiles, readRepoFile, depth = 1 }) {
        const references = [];
        const warnings = [];
        let metadataScanned = 0;
        let filesScanned = 0;
        const scannedPaths = new Set();

        if (!Array.isArray(selectedMetadata) || !Array.isArray(repoFiles)) {
            return {
                references,
                warnings,
                metadataScanned,
                filesScanned
            };
        }

        const normalizedRepoFiles = repoFiles.map(normalizePath);

        for (const item of selectedMetadata) {
            const metadataType = item?.metadataType || item?.type;

            if (metadataType !== 'Layout') {
                continue;
            }

            const layoutMemberName = resolveLayoutName(item);

            if (!layoutMemberName) {
                warnings.push(
                    'Unable to resolve Layout member name for reference discovery.'
                );
                continue;
            }

            const parsed = parseLayoutMemberName(layoutMemberName);

            if (!parsed?.objectApiName) {
                warnings.push(
                    `Unable to parse parent object from Layout member name ${layoutMemberName}.`
                );
                continue;
            }

            const filePath = resolveLayoutFilePath(item, normalizedRepoFiles);

            if (!filePath) {
                warnings.push(
                    `Layout metadata file not found for ${layoutMemberName}.`
                );
                continue;
            }

            if (scannedPaths.has(filePath)) {
                continue;
            }

            scannedPaths.add(filePath);
            metadataScanned += 1;
            filesScanned += 1;

            try {
                const layoutXml = await readRepoFile(filePath);
                const pageDepth = item.depth != null ? item.depth + 1 : depth;

                const parentReference = discoverParentObjectReference(
                    layoutMemberName,
                    layoutMemberName,
                    pageDepth
                );

                if (parentReference) {
                    references.push(parentReference);
                }

                references.push(
                    ...discoverLayoutItemFieldReferences(
                        layoutXml,
                        layoutMemberName,
                        parsed.objectApiName,
                        pageDepth
                    ),
                    ...discoverRelatedListReferences(
                        layoutXml,
                        layoutMemberName,
                        pageDepth
                    ),
                    ...discoverCustomButtonReferences(
                        layoutXml,
                        layoutMemberName,
                        parsed.objectApiName,
                        pageDepth
                    ),
                    ...discoverQuickActionReferences(
                        layoutXml,
                        layoutMemberName,
                        pageDepth
                    ),
                    ...discoverPlatformActionReferences(
                        layoutXml,
                        layoutMemberName,
                        pageDepth
                    ),
                    ...discoverCustomConsoleComponentReferences(
                        layoutXml,
                        layoutMemberName,
                        pageDepth
                    ),
                    ...discoverRelatedObjectReferences(
                        layoutXml,
                        layoutMemberName,
                        parsed.objectApiName,
                        pageDepth
                    )
                );
            } catch (error) {
                warnings.push(
                    `Unable to read Layout metadata ${filePath}: ${
                        error?.message || 'unknown error'
                    }`
                );
            }
        }

        return {
            references: dedupeReferences(references),
            warnings,
            metadataScanned,
            filesScanned
        };
    }
};

module.exports = layoutReferenceDiscoverer;
