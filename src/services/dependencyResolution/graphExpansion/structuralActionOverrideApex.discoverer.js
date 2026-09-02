/**
 * One-hop Apex prerequisite discovery for bounded structural LWC components.
 *
 * Inspects only LightningComponentBundle dependencies discovered via
 * structuralActionOverrideComponent. Emits ApexClass prerequisites and stops.
 */

const apexImportExtractor = require('./extractors/apexImport.extractor');
const {
    DISCOVERY_METHOD: STRUCTURAL_ACTION_OVERRIDE_COMPONENT_DISCOVERY_METHOD
} = require('./structuralActionOverrideComponent.discoverer');

const DISCOVERY_METHOD = 'structuralActionOverrideApex';
const DISCOVERER_ID = 'StructuralActionOverrideApexDiscoverer';
const EXPANSION_POLICY = 'TERMINAL';
const LWC_APEX_RELATIONSHIP = 'LwcApexDependency';

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

function createStructuralActionOverrideApexRecord({
    apexClassName,
    componentName,
    depth
}) {
    return {
        name: apexClassName,
        metadataType: 'ApexClass',
        type: 'ApexClass',
        relationship: LWC_APEX_RELATIONSHIP,
        sourceMetadata: componentName,
        origin: componentName,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        expansionPolicy: EXPANSION_POLICY,
        required: true,
        selected: true,
        depth,
        deployable: true,
        blocking: true,
        reason: `Apex class ${apexClassName} imported by structural Lightning component ${componentName}.`
    };
}

/**
 * Discover one-hop ApexClass prerequisites for bounded structural LWC components.
 *
 * @returns {Promise<{ dependencies: object[], closureCandidates: object[], warnings: string[], filesScanned: number }>}
 */
async function discoverStructuralActionOverrideApexClasses({
    structuralComponentDependencies = [],
    readRepoFile,
    repoFiles
} = {}) {
    const dependencies = [];
    const closureCandidates = [];
    const warnings = [];
    const seenApexClassNames = new Set();
    let filesScanned = 0;

    if (!readRepoFile) {
        return { dependencies, closureCandidates, warnings, filesScanned };
    }

    for (const dependency of structuralComponentDependencies) {
        if (
            dependency?.discoveryMethod !==
            STRUCTURAL_ACTION_OVERRIDE_COMPONENT_DISCOVERY_METHOD
        ) {
            continue;
        }

        const componentName =
            dependency?.name || dependency?.metadataName || null;

        if (!componentName) {
            continue;
        }

        const jsFiles = listBundleJavaScriptFiles(componentName, repoFiles);

        if (!jsFiles.length) {
            warnings.push(
                `No JavaScript source files found for structural LWC prerequisite scan of ${componentName}.`
            );
            continue;
        }

        for (const filePath of jsFiles) {
            try {
                const sourceText = await readRepoFile(filePath);
                filesScanned += 1;

                for (const extracted of apexImportExtractor.extract(
                    sourceText
                ) || []) {
                    const apexClassName = extracted?.name;

                    if (
                        !apexClassName ||
                        extracted?.metadataType !== 'ApexClass' ||
                        seenApexClassNames.has(apexClassName)
                    ) {
                        continue;
                    }

                    seenApexClassNames.add(apexClassName);

                    const record = createStructuralActionOverrideApexRecord({
                        apexClassName,
                        componentName,
                        depth:
                            dependency?.depth != null
                                ? dependency.depth + 1
                                : 3
                    });

                    dependencies.push(record);
                    closureCandidates.push({
                        metadataType: 'ApexClass',
                        metadataName: apexClassName,
                        deployable: true
                    });
                }
            } catch (error) {
                warnings.push(
                    `Unable to read LWC source ${filePath} for structural Apex prerequisite scan: ${
                        error?.message || 'unknown error'
                    }`
                );
            }
        }
    }

    return { dependencies, closureCandidates, warnings, filesScanned };
}

module.exports = {
    DISCOVERY_METHOD,
    DISCOVERER_ID,
    EXPANSION_POLICY,
    LWC_APEX_RELATIONSHIP,
    discoverStructuralActionOverrideApexClasses,
    listBundleJavaScriptFiles
};
