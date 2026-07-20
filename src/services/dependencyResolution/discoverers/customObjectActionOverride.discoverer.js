const path = require('path');

const OBJECT_META_SUFFIX = '.object-meta.xml';
const DISCOVERER_ID = 'CustomObjectActionOverrideDiscoverer';
const DISCOVERY_METHOD = 'actionOverrides';
const RELATIONSHIP = 'ActionOverride';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function getCustomObjectApiName(filePath, metadataName) {
    if (metadataName && !String(metadataName).includes('.')) {
        return String(metadataName).trim();
    }

    const normalizedPath = normalizePath(filePath);
    const baseName = path.posix.basename(normalizedPath);

    if (baseName.endsWith(OBJECT_META_SUFFIX)) {
        return baseName.slice(0, -OBJECT_META_SUFFIX.length);
    }

    const objectsSegment = '/objects/';
    const objectsIndex = normalizedPath.indexOf(objectsSegment);

    if (objectsIndex !== -1) {
        const afterObjects = normalizedPath.slice(
            objectsIndex + objectsSegment.length
        );
        const objectFolderName = afterObjects.split('/')[0];

        if (objectFolderName) {
            return objectFolderName;
        }
    }

    return null;
}

function resolveObjectMetaXmlPath(item, repoFiles) {
    if (
        item?.filePath &&
        normalizePath(item.filePath).endsWith(OBJECT_META_SUFFIX)
    ) {
        return normalizePath(item.filePath);
    }

    const objectApiName = getCustomObjectApiName(
        item?.filePath,
        item?.metadataName
    );

    if (!objectApiName || !Array.isArray(repoFiles)) {
        return null;
    }

    const expectedSuffix = `/objects/${objectApiName}/${objectApiName}${OBJECT_META_SUFFIX}`;

    return (
        repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedSuffix)) || null
    );
}

function extractFlexiPagesFromActionOverrides(content) {
    if (!content) {
        return [];
    }

    const names = [];
    const actionOverrideBlocks = String(content).matchAll(
        /<actionOverrides\b[^>]*>([\s\S]*?)<\/actionOverrides>/gi
    );

    for (const match of actionOverrideBlocks) {
        const block = match[1] || '';
        const typeMatch = block.match(/<type>\s*([^<]+?)\s*<\/type>/i);
        const overrideType = String(typeMatch?.[1] || '')
            .trim()
            .toLowerCase();

        // Visualforce and other override types reserved for future discoverers.
        if (overrideType !== 'flexipage') {
            continue;
        }

        const contentMatch = block.match(
            /<content>\s*([^<]+?)\s*<\/content>/i
        );
        const name = String(contentMatch?.[1] || '').trim();

        if (name) {
            names.push(name);
        }
    }

    return [...new Set(names)];
}

function createRelationshipRecord({
    flexiPageName,
    sourceMetadata,
    depth
}) {
    return {
        name: flexiPageName,
        metadataType: 'FlexiPage',
        type: 'FlexiPage',
        relationship: RELATIONSHIP,
        sourceMetadata,
        sourceField: null,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        required: true,
        selected: true,
        depth,
        reason: 'FlexiPage action override discovered from CustomObject metadata.'
    };
}

/**
 * Discover FlexiPage references from CustomObject actionOverrides.
 */
const customObjectActionOverrideDiscoverer = {
    id: DISCOVERER_ID,

    async discover({ selectedMetadata, repoFiles, readRepoFile, depth = 1 }) {
        const relationships = [];
        const warnings = [];
        let filesScanned = 0;
        let metadataScanned = 0;
        const scannedObjectPaths = new Set();

        if (!Array.isArray(selectedMetadata) || !Array.isArray(repoFiles)) {
            return {
                relationships,
                warnings,
                filesScanned,
                metadataScanned
            };
        }

        const normalizedRepoFiles = repoFiles.map(normalizePath);

        for (const item of selectedMetadata) {
            if (item?.metadataType !== 'CustomObject') {
                continue;
            }

            const objectApiName = getCustomObjectApiName(
                item.filePath,
                item.metadataName
            );

            if (!objectApiName) {
                warnings.push(
                    'Unable to resolve CustomObject API name for action override discovery.'
                );
                continue;
            }

            const objectMetaPath = resolveObjectMetaXmlPath(
                item,
                normalizedRepoFiles
            );

            if (!objectMetaPath) {
                warnings.push(
                    `CustomObject metadata file not found for ${objectApiName}.`
                );
                continue;
            }

            if (scannedObjectPaths.has(objectMetaPath)) {
                continue;
            }

            scannedObjectPaths.add(objectMetaPath);
            metadataScanned += 1;
            filesScanned += 1;

            try {
                const objectXml = await readRepoFile(objectMetaPath);
                const flexiPageNames =
                    extractFlexiPagesFromActionOverrides(objectXml);

                for (const flexiPageName of flexiPageNames) {
                    relationships.push(
                        createRelationshipRecord({
                            flexiPageName,
                            sourceMetadata: objectApiName,
                            depth
                        })
                    );
                }
            } catch (error) {
                warnings.push(
                    `Unable to read CustomObject metadata ${objectMetaPath}: ${
                        error?.message || 'unknown error'
                    }`
                );
            }
        }

        return {
            relationships,
            warnings,
            filesScanned,
            metadataScanned
        };
    }
};

module.exports = customObjectActionOverrideDiscoverer;
