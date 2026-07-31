const path = require('path');

const { buildGraphNodeId } = require('../graphId');
const {
    isSalesforceSystemField,
    isDeployableField
} = require('../../../utils/salesforceSystemFields.util');

const FLEXIPAGE_SUFFIX = '.flexipage-meta.xml';
const DISCOVERER_ID = 'FlexiPageReferenceDiscoverer';

const STANDARD_COMPONENT_PREFIXES = [
    'flexipage:',
    'force:',
    'forceCommunity:',
    'lightning:',
    // Managed related-list / list-view surface (e.g. lst:dynamicRelatedList).
    'lst:',
    'runtime_sales_',
    'runtime_service_',
    'runtime_appointmentbooking_',
    'console:',
    'interaction_explorer:',
    'wits:'
];

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

function resolveFlexiPageName(item) {
    if (item?.metadataName) {
        return String(item.metadataName).trim();
    }

    if (item?.name) {
        return String(item.name).trim();
    }

    if (item?.filePath) {
        const baseName = path.posix.basename(normalizePath(item.filePath));

        if (baseName.endsWith(FLEXIPAGE_SUFFIX)) {
            return baseName.slice(0, -FLEXIPAGE_SUFFIX.length);
        }
    }

    return null;
}

function resolveFlexiPageFilePath(item, repoFiles) {
    if (
        item?.filePath &&
        normalizePath(item.filePath).endsWith(FLEXIPAGE_SUFFIX)
    ) {
        return normalizePath(item.filePath);
    }

    const flexiPageName = resolveFlexiPageName(item);

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
        discoveryMethod: 'flexiPageReference',
        deployable: deployable === true,
        blocking: blocking === true,
        sobjectType,
        relationship: referenceType
    };
}

function discoverFieldReferences(flexiPageXml, sourceMetadata, sobjectType, depth) {
    const references = [];
    const fieldItems = extractAllXmlTagValues(flexiPageXml, 'fieldItem');

    for (const fieldItem of fieldItems) {
        // Examples: Record.Display_Name__c, Record.Account__r.Name
        const withoutPrefix = fieldItem.replace(/^Record\./i, '');
        const parts = withoutPrefix.split('.');
        const fieldApiName = parts[parts.length - 1];

        if (!fieldApiName || parts.length > 2) {
            // Skip deep relationship path fields for now.
            continue;
        }

        if (parts.length === 2 && /__r$/i.test(parts[0])) {
            continue;
        }

        // Salesforce-managed system fields must never enter the deployment graph.
        if (isSalesforceSystemField(fieldApiName)) {
            continue;
        }

        const deployable = isDeployableField(fieldApiName);
        const qualifiedName = sobjectType
            ? `${sobjectType}.${fieldApiName}`
            : fieldApiName;

        references.push(
            createReference({
                name: qualifiedName,
                metadataType: 'CustomField',
                sourceMetadata,
                sourceElement: fieldItem,
                referenceType: 'Field',
                depth,
                reason: 'Referenced by FlexiPage.',
                deployable,
                blocking: deployable,
                sobjectType
            })
        );
    }

    return references;
}

function discoverComponentReferences(flexiPageXml, sourceMetadata, depth) {
    const references = [];
    const componentNames = extractAllXmlTagValues(flexiPageXml, 'componentName');

    for (const componentName of componentNames) {
        if (isStandardManagedComponent(componentName)) {
            continue;
        }

        const localName = normalizeLightningComponentName(componentName);

        if (!localName) {
            continue;
        }

        references.push(
            createReference({
                name: localName,
                metadataType: 'LightningComponentBundle',
                sourceMetadata,
                sourceElement: componentName,
                referenceType: 'LightningComponent',
                depth,
                reason: 'Lightning component referenced by FlexiPage.',
                deployable: true,
                blocking: true
            })
        );
    }

    return references;
}

function discoverRelatedListReferences(flexiPageXml, sourceMetadata, depth) {
    const references = [];
    const componentBlocks = String(flexiPageXml).matchAll(
        /<componentInstance\b[^>]*>([\s\S]*?)<\/componentInstance>/gi
    );

    for (const match of componentBlocks) {
        const block = match[1] || '';
        const componentName = extractXmlTagValue(block, 'componentName');

        if (
            !componentName ||
            !/relatedList/i.test(componentName)
        ) {
            continue;
        }

        const propertyBlocks = block.matchAll(
            /<componentInstanceProperties\b[^>]*>([\s\S]*?)<\/componentInstanceProperties>/gi
        );

        for (const propertyMatch of propertyBlocks) {
            const propertyBlock = propertyMatch[1] || '';
            const propertyName = extractXmlTagValue(propertyBlock, 'name');
            const propertyValue = extractXmlTagValue(propertyBlock, 'value');

            if (
                !propertyValue ||
                !propertyName ||
                !/relatedList/i.test(propertyName)
            ) {
                continue;
            }

            references.push(
                createReference({
                    name: propertyValue,
                    metadataType: 'RelatedList',
                    sourceMetadata,
                    sourceElement: propertyName,
                    referenceType: 'RelatedList',
                    depth,
                    reason: 'Related list referenced by FlexiPage.',
                    deployable: false,
                    blocking: false
                })
            );
        }
    }

    return references;
}

function discoverQuickActionReferences(flexiPageXml, sourceMetadata, depth) {
    const references = [];
    const componentBlocks = String(flexiPageXml).matchAll(
        /<componentInstance\b[^>]*>([\s\S]*?)<\/componentInstance>/gi
    );

    for (const match of componentBlocks) {
        const block = match[1] || '';
        const componentName = extractXmlTagValue(block, 'componentName');

        if (
            !componentName ||
            !/highlightsPanel|actionsBar|platformAction/i.test(componentName)
        ) {
            continue;
        }

        const valueItems = extractAllXmlTagValues(block, 'value');

        for (const value of valueItems) {
            // Custom object quick actions look like Object.ActionName
            if (!value.includes('.') && !/__c$/i.test(value)) {
                continue;
            }

            if (
                [
                    'Edit',
                    'Clone',
                    'Delete',
                    'ChangeOwner',
                    'PrintableView',
                    'Submit',
                    'Share',
                    'NewContact',
                    'NewOpportunity',
                    'NewTask',
                    'NewEvent',
                    'FeedItem.TextPost',
                    'FeedItem.ContentPost',
                    'Global.NewTask',
                    'Global.NewEvent',
                    'Global.LogACall',
                    'Global.NewNote'
                ].includes(value)
            ) {
                continue;
            }

            references.push(
                createReference({
                    name: value,
                    metadataType: 'QuickAction',
                    sourceMetadata,
                    sourceElement: componentName,
                    referenceType: 'QuickAction',
                    depth,
                    reason: 'Quick action referenced by FlexiPage.',
                    deployable: true,
                    blocking: false
                })
            );
        }
    }

    return references;
}

function discoverVisualforceReferences(flexiPageXml, sourceMetadata, depth) {
    const references = [];
    const componentBlocks = String(flexiPageXml).matchAll(
        /<componentInstance\b[^>]*>([\s\S]*?)<\/componentInstance>/gi
    );

    for (const match of componentBlocks) {
        const block = match[1] || '';
        const componentName = extractXmlTagValue(block, 'componentName');

        if (
            !componentName ||
            !/visualforcePage/i.test(componentName)
        ) {
            continue;
        }

        const propertyBlocks = block.matchAll(
            /<componentInstanceProperties\b[^>]*>([\s\S]*?)<\/componentInstanceProperties>/gi
        );

        for (const propertyMatch of propertyBlocks) {
            const propertyBlock = propertyMatch[1] || '';
            const propertyName = extractXmlTagValue(propertyBlock, 'name');
            const propertyValue = extractXmlTagValue(propertyBlock, 'value');

            if (
                !propertyValue ||
                !propertyName ||
                !/pageName|page/i.test(propertyName)
            ) {
                continue;
            }

            references.push(
                createReference({
                    name: propertyValue,
                    metadataType: 'ApexPage',
                    sourceMetadata,
                    sourceElement: propertyName,
                    referenceType: 'VisualforcePage',
                    depth,
                    reason: 'Visualforce page referenced by FlexiPage.',
                    deployable: true,
                    blocking: true
                })
            );
        }
    }

    return references;
}

function discoverRecordTypeReferences(flexiPageXml, sourceMetadata, sobjectType, depth) {
    const references = [];
    const criteriaBlocks = String(flexiPageXml).matchAll(
        /<criteria\b[^>]*>([\s\S]*?)<\/criteria>/gi
    );

    for (const match of criteriaBlocks) {
        const block = match[1] || '';
        const leftValue = extractXmlTagValue(block, 'leftValue');
        const rightValue = extractXmlTagValue(block, 'rightValue');

        if (
            !leftValue ||
            !rightValue ||
            !/RecordType/i.test(leftValue)
        ) {
            continue;
        }

        const name = sobjectType
            ? `${sobjectType}.${rightValue}`
            : rightValue;

        references.push(
            createReference({
                name,
                metadataType: 'RecordType',
                sourceMetadata,
                sourceElement: leftValue,
                referenceType: 'RecordType',
                depth,
                reason: 'Record type referenced by FlexiPage visibility rule.',
                deployable: true,
                blocking: false,
                sobjectType
            })
        );
    }

    return references;
}

function discoverTabReferences(flexiPageXml, sourceMetadata, depth) {
    const references = [];
    const componentBlocks = String(flexiPageXml).matchAll(
        /<componentInstance\b[^>]*>([\s\S]*?)<\/componentInstance>/gi
    );

    for (const match of componentBlocks) {
        const block = match[1] || '';
        const componentName = extractXmlTagValue(block, 'componentName');

        if (!componentName || !/flexipage:tab\b/i.test(componentName)) {
            continue;
        }

        const propertyBlocks = block.matchAll(
            /<componentInstanceProperties\b[^>]*>([\s\S]*?)<\/componentInstanceProperties>/gi
        );

        for (const propertyMatch of propertyBlocks) {
            const propertyBlock = propertyMatch[1] || '';
            const propertyName = extractXmlTagValue(propertyBlock, 'name');
            const propertyValue = extractXmlTagValue(propertyBlock, 'value');

            if (
                propertyName !== 'title' ||
                !propertyValue ||
                !propertyValue.startsWith('Standard.')
            ) {
                continue;
            }

            references.push(
                createReference({
                    name: propertyValue,
                    metadataType: 'CustomTab',
                    sourceMetadata,
                    sourceElement: propertyName,
                    referenceType: 'Tab',
                    depth,
                    reason: 'Tab referenced by FlexiPage.',
                    deployable: false,
                    blocking: false
                })
            );
        }
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
 * Discover internal metadata references inside FlexiPage XML.
 */
const flexiPageReferenceDiscoverer = {
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

            if (metadataType !== 'FlexiPage') {
                continue;
            }

            const flexiPageName = resolveFlexiPageName(item);

            if (!flexiPageName) {
                warnings.push(
                    'Unable to resolve FlexiPage name for reference discovery.'
                );
                continue;
            }

            const filePath = resolveFlexiPageFilePath(item, normalizedRepoFiles);

            if (!filePath) {
                warnings.push(
                    `FlexiPage metadata file not found for ${flexiPageName}.`
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
                const flexiPageXml = await readRepoFile(filePath);
                const sobjectType = extractXmlTagValue(
                    flexiPageXml,
                    'sobjectType'
                );
                const pageDepth = item.depth != null ? item.depth + 1 : depth;

                const pageReferences = [
                    ...discoverFieldReferences(
                        flexiPageXml,
                        flexiPageName,
                        sobjectType,
                        pageDepth
                    ),
                    ...discoverComponentReferences(
                        flexiPageXml,
                        flexiPageName,
                        pageDepth
                    ),
                    ...discoverRelatedListReferences(
                        flexiPageXml,
                        flexiPageName,
                        pageDepth
                    ),
                    ...discoverQuickActionReferences(
                        flexiPageXml,
                        flexiPageName,
                        pageDepth
                    ),
                    ...discoverVisualforceReferences(
                        flexiPageXml,
                        flexiPageName,
                        pageDepth
                    ),
                    ...discoverRecordTypeReferences(
                        flexiPageXml,
                        flexiPageName,
                        sobjectType,
                        pageDepth
                    ),
                    ...discoverTabReferences(
                        flexiPageXml,
                        flexiPageName,
                        pageDepth
                    )
                ];

                references.push(...pageReferences);
            } catch (error) {
                warnings.push(
                    `Unable to read FlexiPage metadata ${filePath}: ${
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

module.exports = flexiPageReferenceDiscoverer;
