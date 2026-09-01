const path = require('path');

const { buildGraphNodeId } = require('../graphId');
const { parseLayoutMemberName } = require('../../../utils/layoutMemberName.util');
const {
    isSalesforceSystemField,
    isDeployableField
} = require('../../../utils/salesforceSystemFields.util');

const LAYOUT_SUFFIX = '.layout-meta.xml';
const DISCOVERER_ID = 'LayoutReferenceDiscoverer';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
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

function discoverFieldReferences(layoutXml, sourceMetadata, objectApiName, depth) {
    const references = [];
    const fieldApiNames = extractAllXmlTagValues(layoutXml, 'field');

    for (const fieldApiName of fieldApiNames) {
        if (!fieldApiName || fieldApiName.includes('.')) {
            // V1: only bare field API names on the layout parent object.
            continue;
        }

        if (isSalesforceSystemField(fieldApiName)) {
            continue;
        }

        const deployable = isDeployableField(fieldApiName);

        if (!deployable) {
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
 * Discover parent object and custom field references inside Layout XML.
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
                    ...discoverFieldReferences(
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
