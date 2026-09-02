/**
 * Bounded LWC prerequisite discovery for structural ActionOverride FlexiPages.
 *
 * Inspects only structurally required actionOverride FlexiPages and emits
 * custom LightningComponentBundle prerequisites — never full FlexiPage expansion.
 */

const {
    isStructuralActionOverrideFlexiPage
} = require('./discoverers/flexiPage.graphDiscoverer');
const {
    resolveFlexiPageFilePath
} = require('./customObjectStructuralDependencies.service');

const DISCOVERY_METHOD = 'structuralActionOverrideComponent';
const DISCOVERER_ID = 'StructuralActionOverrideComponentDiscoverer';
const EXPANSION_POLICY = 'PREREQUISITE_ONLY';
const ACTION_OVERRIDE_COMPONENT_RELATIONSHIP = 'ActionOverrideComponent';

const STANDARD_COMPONENT_PREFIXES = [
    'flexipage:',
    'force:',
    'forceCommunity:',
    'lightning:',
    'lst:',
    'runtime_sales_',
    'runtime_service_',
    'runtime_appointmentbooking_',
    'console:',
    'interaction_explorer:',
    'wits:'
];

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

function isStandardManagedComponent(componentName) {
    const normalized = String(componentName || '').trim();

    if (!normalized) {
        return true;
    }

    return STANDARD_COMPONENT_PREFIXES.some((prefix) =>
        normalized.toLowerCase().startsWith(prefix.toLowerCase())
    );
}

function normalizeLightningComponentName(componentName) {
    const normalized = String(componentName || '').trim();

    if (!normalized) {
        return null;
    }

    if (normalized.includes(':')) {
        const [, localName] = normalized.split(':');
        return localName || null;
    }

    return normalized;
}

function extractStructuralActionOverrideComponentNames(flexiPageXml) {
    const componentNames = new Set();

    for (const componentName of extractAllXmlTagValues(
        flexiPageXml,
        'componentName'
    )) {
        if (isStandardManagedComponent(componentName)) {
            continue;
        }

        const localName = normalizeLightningComponentName(componentName);

        if (localName) {
            componentNames.add(localName);
        }
    }

    return [...componentNames];
}

function isStructuralActionOverrideFlexiPageDependency(dependency) {
    const metadataType = dependency?.metadataType || dependency?.type;

    if (metadataType !== 'FlexiPage') {
        return false;
    }

    return isStructuralActionOverrideFlexiPage({
        origin: dependency?.origin,
        relationship: dependency?.relationship,
        discoveryMethod: dependency?.discoveryMethod
    });
}

function createStructuralActionOverrideComponentRecord({
    componentName,
    flexiPageName,
    depth
}) {
    return {
        name: componentName,
        metadataType: 'LightningComponentBundle',
        type: 'LightningComponentBundle',
        relationship: ACTION_OVERRIDE_COMPONENT_RELATIONSHIP,
        sourceMetadata: flexiPageName,
        origin: flexiPageName,
        discoveredBy: DISCOVERER_ID,
        discoveryMethod: DISCOVERY_METHOD,
        expansionPolicy: EXPANSION_POLICY,
        required: true,
        selected: true,
        depth,
        deployable: true,
        blocking: true,
        reason: `Lightning component ${componentName} referenced by structural FlexiPage action override ${flexiPageName}.`
    };
}

/**
 * Discover bounded LightningComponentBundle prerequisites from structural
 * actionOverride FlexiPages.
 *
 * @returns {Promise<{ dependencies: object[], closureCandidates: object[], warnings: string[], filesScanned: number }>}
 */
async function discoverStructuralActionOverrideComponents({
    structuralFlexiPageDependencies = [],
    readRepoFile,
    repoFiles
} = {}) {
    const dependencies = [];
    const closureCandidates = [];
    const warnings = [];
    const seenComponentNames = new Set();
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
            resolveFlexiPageFilePath(flexiPageName, repoFiles);

        if (!filePath) {
            warnings.push(
                `FlexiPage metadata path not found for structural component scan of ${flexiPageName}.`
            );
            continue;
        }

        let flexiPageXml;

        try {
            flexiPageXml = await readRepoFile(filePath);
            filesScanned += 1;
        } catch (error) {
            warnings.push(
                `Unable to read FlexiPage metadata ${filePath} for structural component scan: ${
                    error?.message || 'unknown error'
                }`
            );
            continue;
        }

        for (const componentName of extractStructuralActionOverrideComponentNames(
            flexiPageXml
        )) {
            if (seenComponentNames.has(componentName)) {
                continue;
            }

            seenComponentNames.add(componentName);

            const record = createStructuralActionOverrideComponentRecord({
                componentName,
                flexiPageName,
                depth:
                    dependency?.depth != null ? dependency.depth + 1 : 2
            });

            dependencies.push(record);
            closureCandidates.push({
                metadataType: 'LightningComponentBundle',
                metadataName: componentName,
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
    ACTION_OVERRIDE_COMPONENT_RELATIONSHIP,
    discoverStructuralActionOverrideComponents,
    extractStructuralActionOverrideComponentNames,
    isStructuralActionOverrideFlexiPageDependency,
    normalizeLightningComponentName
};
