/**
 * Permission Set Compatibility Analyzer (Phase 13.1).
 *
 * READ-ONLY. Reports PermissionSet XML properties that are incompatible with
 * the deployment Metadata API version. It never rewrites, filters, or removes
 * metadata and never changes deployment behavior.
 */

const permissionSetCompatibilityTrace = require('./permissionSetCompatibilityTrace.temp');

const TOP_LEVEL_PROPERTY_VERSIONS = Object.freeze({
    agentAccesses: Object.freeze({ min: 63 }),
    applicationVisibilities: Object.freeze({ min: 29 }),
    classAccesses: Object.freeze({ min: 23 }),
    customMetadataTypeAccesses: Object.freeze({ min: 47 }),
    customPermissions: Object.freeze({ min: 31 }),
    customSettingAccesses: Object.freeze({ min: 47 }),
    emailRoutingAddressAccesses: Object.freeze({ min: 62 }),
    externalCredentialPrincipalAccesses: Object.freeze({ min: 59 }),
    externalDataSourceAccesses: Object.freeze({ min: 27 }),
    fieldPermissions: Object.freeze({ min: 23 }),
    flowAccesses: Object.freeze({ min: 47 }),
    hasActivationRequired: Object.freeze({ min: 37 }),
    license: Object.freeze({ min: 38 }),
    genComputingSummaryDefAccess: Object.freeze({ min: 66 }),
    objectPermissions: Object.freeze({ min: 23 }),
    pageAccesses: Object.freeze({ min: 23 }),
    recordTypeVisibilities: Object.freeze({ min: 29 }),
    ServicePresenceStatusAccesses: Object.freeze({ min: 64 }),
    servicePresenceStatusAccesses: Object.freeze({ min: 64 }),
    tabSettings: Object.freeze({ min: 26 }),
    userLicense: Object.freeze({ max: 37 }),
    userPermissions: Object.freeze({ min: 22 }),
    description: Object.freeze({ min: 22 }),
    label: Object.freeze({ min: 22 })
});

const NESTED_PROPERTY_VERSIONS = Object.freeze({
    'objectPermissions.viewAllFields': Object.freeze({
        min: 63,
        additive: true,
        optional: true,
        mandatory: false,
        safeToRemove: false,
        safeToIgnore: false,
        requiredForDeployment: false,
        requiredToPreserveIntent: true,
        omissionBehavior:
            'NOT_RECREATED — omitting the property does not preserve the View All Fields grant.',
        recommendedAction:
            'Deploy with Metadata API version 63.0 or later to preserve View All Fields. If the destination cannot support API 63.0, replace the grant with explicit fieldPermissions only after security review.'
    })
});

function emptyPermissionSetCompatibility() {
    return {
        overallStatus: 'PASS',
        detectedApiVersion: null,
        permissionSets: [],
        unsupportedProperties: [],
        compatibilityFindings: [],
        summary: {
            analyzed: 0,
            compatible: 0,
            incompatible: 0,
            malformed: 0,
            unsupportedPropertyCount: 0,
            requiresUserAttention: false
        }
    };
}

function normalizeApiVersion(value) {
    const match = String(value ?? '').trim().match(/^(\d+)(?:\.(\d+))?/);

    if (!match) {
        return null;
    }

    return `${match[1]}.${match[2] || '0'}`;
}

function apiMajor(value) {
    const normalized = normalizeApiVersion(value);
    return normalized ? Number(normalized.split('.')[0]) : null;
}

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function collectPermissionSetItems(generatedDeploymentPackage) {
    const byName = new Map();
    const items = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];

    for (const item of items) {
        if (getItemType(item) !== 'PermissionSet') {
            continue;
        }

        const name = getItemName(item) || item?.filePath || null;

        if (name && !byName.has(name)) {
            byName.set(name, item);
        }
    }

    return [...byName.values()];
}

function stripXmlName(name) {
    return String(name || '').split(':').pop();
}

/**
 * Parse element paths with a small strict tokenizer. Values and attributes are
 * intentionally ignored; compatibility depends on element names and nesting.
 */
function inspectXmlStructure(xml) {
    const source = String(xml || '');

    if (!source.trim()) {
        throw new Error('PermissionSet XML is empty.');
    }

    const sanitized = source
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    const tokens = sanitized.match(/<[^>]+>/g) || [];
    const stack = [];
    const paths = [];
    const topLevelNodes = [];
    let root = null;

    for (const token of tokens) {
        if (/^<\?/.test(token) || /^<!/.test(token)) {
            continue;
        }

        const closing = token.match(/^<\s*\/\s*([A-Za-z_][\w:.-]*)\s*>$/);

        if (closing) {
            const closingName = stripXmlName(closing[1]);
            const openName = stack.pop();

            if (openName !== closingName) {
                throw new Error(
                    `Malformed XML: closing ${closingName} does not match ${openName || 'none'}.`
                );
            }
            continue;
        }

        const opening = token.match(/^<\s*([A-Za-z_][\w:.-]*)\b[^>]*>$/);

        if (!opening) {
            continue;
        }

        const name = stripXmlName(opening[1]);
        const selfClosing = /\/\s*>$/.test(token);

        if (!root) {
            root = name;
        } else {
            const path = [...stack, name].slice(1).join('.');
            paths.push(path);

            if (stack.length === 1) {
                topLevelNodes.push(name);
            }
        }

        if (!selfClosing) {
            stack.push(name);
        }
    }

    if (stack.length) {
        throw new Error(
            `Malformed XML: unclosed element ${stack[stack.length - 1]}.`
        );
    }

    if (root !== 'PermissionSet') {
        throw new Error(
            `Malformed PermissionSet XML: expected PermissionSet root, found ${root || 'none'}.`
        );
    }

    return {
        topLevelNodes: [...new Set(topLevelNodes)],
        paths: [...new Set(paths)]
    };
}

function createUnsupportedFinding({
    permissionSet,
    property,
    deploymentApiVersion,
    requirement
}) {
    const minimum = requirement.min ? `${requirement.min}.0` : null;
    const maximum = requirement.max ? `${requirement.max}.0` : null;
    const versionRule = minimum
        ? `available in API ${minimum} and later`
        : `available only through API ${maximum}`;

    return {
        permissionSet,
        property,
        category: 'PERMISSION_SET_API_VERSION',
        rootCause: 'PERMISSION_SET_XML_SCHEMA_EVOLUTION',
        severity: 'WARNING',
        reason: `${property} is ${versionRule}, but deployment uses API ${deploymentApiVersion || 'unknown'}.`,
        salesforceBehavior:
            'Salesforce validates PermissionSet XML against the deployment Metadata API schema and rejects properties unavailable in that version.',
        additive: requirement.additive !== false,
        optional: requirement.optional !== false,
        mandatory: requirement.mandatory === true,
        safeToRemove: requirement.safeToRemove === true,
        safeToIgnore: requirement.safeToIgnore === true,
        requiresVersionUpgrade: minimum !== null,
        requiredForDeployment: requirement.requiredForDeployment === true,
        requiredToPreserveIntent:
            requirement.requiredToPreserveIntent !== false,
        omissionBehavior:
            requirement.omissionBehavior ||
            'NOT_RECREATED — omitted permission grants are not automatically restored by Salesforce.',
        recommendedAction:
            requirement.recommendedAction ||
            `Use a Metadata API version that supports ${property}, or perform a security-reviewed manual equivalent.`,
        documentationHint:
            'Salesforce Metadata API Developer Guide: PermissionSet property availability by API version.'
    };
}

function findUnsupportedProperties({
    permissionSet,
    structure,
    deploymentApiVersion
}) {
    const major = apiMajor(deploymentApiVersion);
    const findings = [];

    if (major == null) {
        return findings;
    }

    for (const node of structure.topLevelNodes) {
        const requirement = TOP_LEVEL_PROPERTY_VERSIONS[node];

        if (
            requirement &&
            ((requirement.min && major < requirement.min) ||
                (requirement.max && major > requirement.max))
        ) {
            findings.push(
                createUnsupportedFinding({
                    permissionSet,
                    property: node,
                    deploymentApiVersion,
                    requirement
                })
            );
        }
    }

    for (const [property, requirement] of Object.entries(
        NESTED_PROPERTY_VERSIONS
    )) {
        if (
            structure.paths.includes(property) &&
            ((requirement.min && major < requirement.min) ||
                (requirement.max && major > requirement.max))
        ) {
            findings.push(
                createUnsupportedFinding({
                    permissionSet,
                    property,
                    deploymentApiVersion,
                    requirement
                })
            );
        }
    }

    return findings;
}

function buildUnknownFindings(permissionSet, unknownNodes) {
    return unknownNodes.map((node) => ({
        permissionSet,
        property: node,
        category: 'PERMISSION_SET_UNKNOWN_PROPERTY',
        severity: 'WARNING',
        reason: `${node} is not present in the analyzer's known PermissionSet top-level schema catalog.`,
        recommendedAction:
            'Verify the property against the Salesforce Metadata API documentation for the deployment version.',
        safeToRemove: false,
        requiresUserAttention: true
    }));
}

async function readPermissionSetXml(item, readFile) {
    if (typeof item?.content === 'string') {
        return item.content;
    }

    if (typeof readFile === 'function' && item?.filePath) {
        return readFile(item.filePath);
    }

    return null;
}

function resolveRecommendedAction(findings, malformed) {
    if (malformed) {
        return 'Correct the malformed PermissionSet XML before deployment.';
    }

    if (!findings.length) {
        return 'No compatibility action required for the detected API version.';
    }

    if (
        findings.some(
            (finding) =>
                finding.property === 'objectPermissions.viewAllFields'
        )
    ) {
        return NESTED_PROPERTY_VERSIONS[
            'objectPermissions.viewAllFields'
        ].recommendedAction;
    }

    return 'Upgrade the deployment API version to one that supports the reported properties, or complete a security-reviewed manual migration.';
}

async function analyzePermissionSetCompatibility({
    generatedDeploymentPackage,
    deploymentApiVersionPolicy = null,
    readFile = null
} = {}) {
    const result = emptyPermissionSetCompatibility();
    const deploymentApiVersion = normalizeApiVersion(
        deploymentApiVersionPolicy?.deploymentApiVersion
    );
    result.detectedApiVersion = deploymentApiVersion;

    const items = collectPermissionSetItems(generatedDeploymentPackage);

    for (const item of items) {
        const permissionSet = getItemName(item);
        const filePath = item?.filePath || null;
        let xml = null;
        let structure = { topLevelNodes: [], paths: [] };
        let malformed = false;
        let malformedMessage = null;

        try {
            xml = await readPermissionSetXml(item, readFile);
            structure = inspectXmlStructure(xml);
        } catch (error) {
            malformed = true;
            malformedMessage =
                error?.message || 'Unable to parse PermissionSet XML.';
        }

        const unknownNodes = structure.topLevelNodes.filter(
            (node) => !TOP_LEVEL_PROPERTY_VERSIONS[node]
        );
        const unsupportedFindings = malformed
            ? []
            : findUnsupportedProperties({
                  permissionSet,
                  structure,
                  deploymentApiVersion
              });
        const unknownFindings = buildUnknownFindings(
            permissionSet,
            unknownNodes
        );
        const malformedFindings = malformed
            ? [
                  {
                      permissionSet,
                      property: null,
                      category: 'PERMISSION_SET_MALFORMED_XML',
                      severity: 'WARNING',
                      reason: malformedMessage,
                      recommendedAction:
                          'Correct the malformed PermissionSet XML before deployment.',
                      safeToRemove: false,
                      requiresUserAttention: true
                  }
              ]
            : [];
        const compatibilityFindings = [
            ...unsupportedFindings,
            ...unknownFindings,
            ...malformedFindings
        ];
        const unsupportedProperties = unsupportedFindings.map(
            (finding) => finding.property
        );
        const requiresUserAttention = compatibilityFindings.length > 0;

        const diagnostic = {
            permissionSet,
            detectedApiVersion: deploymentApiVersion,
            filePath,
            topLevelXmlNodes: structure.topLevelNodes,
            unknownNodes,
            unsupportedProperties,
            compatibilityFindings,
            recommendedAction: resolveRecommendedAction(
                compatibilityFindings,
                malformed
            ),
            safeToRemove:
                unsupportedFindings.length > 0 &&
                unsupportedFindings.every(
                    (finding) => finding.safeToRemove === true
                ),
            requiresUserAttention,
            malformedXml: malformed
        };

        result.permissionSets.push(diagnostic);
        result.unsupportedProperties.push(
            ...unsupportedProperties.map((property) => ({
                permissionSet,
                property
            }))
        );
        result.compatibilityFindings.push(...compatibilityFindings);

        permissionSetCompatibilityTrace.logPermissionSetCompatibilityTrace({
            ...diagnostic,
            xml
        });
    }

    result.summary = {
        analyzed: result.permissionSets.length,
        compatible: result.permissionSets.filter(
            (item) => !item.requiresUserAttention
        ).length,
        incompatible: result.permissionSets.filter(
            (item) => item.unsupportedProperties.length > 0
        ).length,
        malformed: result.permissionSets.filter((item) => item.malformedXml)
            .length,
        unsupportedPropertyCount: result.unsupportedProperties.length,
        requiresUserAttention: result.permissionSets.some(
            (item) => item.requiresUserAttention
        )
    };
    result.overallStatus = result.summary.requiresUserAttention
        ? 'WARNING'
        : 'PASS';

    return result;
}

async function analyzePermissionSetCompatibilitySafe(input) {
    try {
        return await analyzePermissionSetCompatibility(input);
    } catch (error) {
        return emptyPermissionSetCompatibility();
    }
}

module.exports = {
    TOP_LEVEL_PROPERTY_VERSIONS,
    NESTED_PROPERTY_VERSIONS,
    emptyPermissionSetCompatibility,
    inspectXmlStructure,
    findUnsupportedProperties,
    analyzePermissionSetCompatibility,
    analyzePermissionSetCompatibilitySafe
};
