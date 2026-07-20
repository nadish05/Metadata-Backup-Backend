/**
 * LightningComponentBundle graph discoverer.
 * Uses the source extractor registry (Apex imports only in this phase).
 */

const {
    getExtractorsForMetadataType
} = require('../extractors/extractorRegistry');
const {
    createEmptyDiscoveryResult,
    createGraphNode,
    createGraphEdge
} = require('../discoveryContract');

const DISCOVERER_ID = 'LightningComponentBundleGraphDiscoverer';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function listBundleJavaScriptFiles(componentName, repoFiles) {
    const marker = `/lwc/${componentName}/`;
    const normalizedFiles = (repoFiles || []).map(normalizePath);

    return normalizedFiles.filter((filePath) => {
        if (!filePath.includes(marker)) {
            return false;
        }

        if (!filePath.endsWith('.js')) {
            return false;
        }

        if (filePath.includes('/__tests__/') || filePath.includes('/test/')) {
            return false;
        }

        return true;
    });
}

const lightningComponentBundleGraphDiscoverer = {
    id: DISCOVERER_ID,
    metadataTypes: ['LightningComponentBundle'],

    async discover({ metadata, repoFiles, readRepoFile, depth = 1 }) {
        const result = createEmptyDiscoveryResult({
            metadataScanned: 0,
            filesScanned: 0
        });

        const componentName = metadata?.name || metadata?.metadataName;

        if (!componentName) {
            result.warnings.push(
                'LightningComponentBundle discoverer received metadata without a name.'
            );
            return result;
        }

        const jsFiles = listBundleJavaScriptFiles(componentName, repoFiles);
        result.statistics.metadataScanned = 1;

        if (!jsFiles.length) {
            result.warnings.push(
                `No JavaScript source files found for LightningComponentBundle ${componentName}.`
            );
            return result;
        }

        const extractors = getExtractorsForMetadataType(
            'LightningComponentBundle'
        );
        const seen = new Set();

        for (const filePath of jsFiles) {
            try {
                const sourceText = await readRepoFile(filePath);
                result.statistics.filesScanned += 1;

                for (const extractor of extractors) {
                    const extracted = extractor.extract(sourceText) || [];

                    for (const item of extracted) {
                        if (!item?.name || !item?.metadataType) {
                            continue;
                        }

                        const key = `${item.metadataType}:${item.name}`;

                        if (seen.has(key)) {
                            continue;
                        }

                        seen.add(key);

                        const node = createGraphNode({
                            name: item.name,
                            metadataType: item.metadataType,
                            deployable: true,
                            blocking: true,
                            sourceMetadata: componentName,
                            discoveredBy: DISCOVERER_ID,
                            discoveryMethod: extractor.id || 'sourceExtractor',
                            referenceType: 'SourceImport',
                            reason: `Referenced by LightningComponentBundle ${componentName} via ${item.rawMatch || 'source import'}.`,
                            depth: depth + 1
                        });

                        result.discoveredNodes.push(node);
                        result.discoveredEdges.push(
                            createGraphEdge({
                                fromType: 'LightningComponentBundle',
                                fromName: componentName,
                                toType: item.metadataType,
                                toName: item.name,
                                relationship: 'SourceImport',
                                discoveredBy: DISCOVERER_ID,
                                reason: node.reason
                            })
                        );
                    }
                }
            } catch (error) {
                result.warnings.push(
                    `Unable to analyze ${filePath}: ${
                        error?.message || 'unknown error'
                    }`
                );
            }
        }

        return result;
    }
};

module.exports = lightningComponentBundleGraphDiscoverer;
