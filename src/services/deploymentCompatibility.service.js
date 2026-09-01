/**
 * Deployment Compatibility Planner (Phase 10.24).
 *
 * READ-ONLY destination / compile compatibility analysis.
 * Distinct from dependency discovery. Does not modify package,
 * planner, workspace, or deployment execution.
 */

const metadataApiAdoptionTrace = require('./metadataApiAdoptionTrace.temp');

const CATEGORIES = Object.freeze({
    FORMULA_TYPE_CHANGE: 'FORMULA_TYPE_CHANGE',
    FORMULA_COMPILATION: 'FORMULA_COMPILATION',
    FLOW_API_VERSION: 'FLOW_API_VERSION',
    LWC_DEPENDENCY: 'LWC_DEPENDENCY',
    FLEXIPAGE_DEPENDENCY: 'FLEXIPAGE_DEPENDENCY',
    PERMISSION_SET_API_VERSION: 'PERMISSION_SET_API_VERSION'
});

const FLOW_API_COMPAT_TAGS = Object.freeze([
    {
        tag: 'areMetricsLoggedToDataCloud',
        minimumApiVersion: 64,
        message:
            'Flow property areMetricsLoggedToDataCloud may be unsupported by the selected deployment API version.'
    }
]);

function extractXmlTagValue(xml, tagName) {
    if (!xml || !tagName) {
        return null;
    }

    const pattern = new RegExp(
        `<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(xml).match(pattern);

    return match ? match[1].trim() : null;
}

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function packageKey(type, name) {
    if (!type || !name) {
        return null;
    }

    return `${String(type)}:${String(name)}`;
}

function buildPackageMembership(generatedDeploymentPackage) {
    const keys = new Set();
    const byType = new Map();
    const items = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];

    for (const item of items) {
        const type = getItemType(item);
        const name = getItemName(item);
        const key = packageKey(type, name);

        if (!key) {
            continue;
        }

        keys.add(key);

        if (!byType.has(type)) {
            byType.set(type, []);
        }

        byType.get(type).push(item);
    }

    return { keys, byType, items };
}

function hasPackageMember(membership, type, name) {
    return membership.keys.has(packageKey(type, name));
}

function createWarning({
    metadataName,
    metadataType,
    category,
    severity = 'WARNING',
    message,
    recommendation,
    ...details
}) {
    return {
        metadataName,
        metadataType,
        category,
        severity,
        message,
        recommendation,
        ...details
    };
}

async function readItemContent(item, readFile) {
    if (typeof item?.content === 'string' && item.content.length) {
        return item.content;
    }

    if (typeof item?.metaXmlContent === 'string' && item.metaXmlContent.length) {
        return item.metaXmlContent;
    }

    if (typeof readFile === 'function' && item?.filePath) {
        try {
            return await readFile(item.filePath);
        } catch (error) {
            return null;
        }
    }

    return null;
}

function mapFormulaCompatibilityWarnings(formulaCompatibility) {
    const warnings = [];
    const sourceWarnings = Array.isArray(formulaCompatibility?.warnings)
        ? formulaCompatibility.warnings
        : [];

    for (const warning of sourceWarnings) {
        const sourceCategory = warning?.category;
        let category = CATEGORIES.FORMULA_COMPILATION;
        let recommendation =
            'Deploy referenced fields first or update the formula expression.';

        if (
            sourceCategory === 'FORMULA_CONVERSION' ||
            /cannot update.*to (a )?formula/i.test(
                String(warning?.message || '')
            )
        ) {
            category = CATEGORIES.FORMULA_TYPE_CHANGE;
            recommendation =
                'Destination field type cannot convert to Formula. Deploy as a new field or change the destination field type manually before deploy.';
        } else if (sourceCategory === 'PICKLIST_USAGE') {
            recommendation =
                'Replace string comparisons with ISPICKVAL() or TEXT() for picklist-safe formulas.';
        } else if (sourceCategory === 'ROLLUP_REFERENCE') {
            recommendation =
                'Include summarizedField, summaryForeignKey, and filter fields in the deployment package.';
        } else if (
            sourceCategory === 'MISSING_RELATION' ||
            sourceCategory === 'MISSING_FIELD'
        ) {
            recommendation =
                'Deploy referenced picklist/field changes first or update the formula.';
        }

        warnings.push(
            createWarning({
                metadataName: warning?.metadataName || null,
                metadataType: warning?.metadataType || 'CustomField',
                category,
                severity: warning?.severity || 'WARNING',
                message: warning?.message || 'Formula compatibility warning.',
                recommendation
            })
        );
    }

    return warnings;
}

function mapExistingFindingWarnings(existingFindings = []) {
    const warnings = [];

    for (const finding of existingFindings) {
        const message = String(
            finding?.message ||
                finding?.problem ||
                finding?.detail ||
                finding ||
                ''
        );
        const metadataName =
            finding?.metadataName || finding?.name || finding?.fullName || null;
        const metadataType =
            finding?.metadataType || finding?.type || 'CustomField';

        if (/cannot update.*to (a )?formula/i.test(message)) {
            warnings.push(
                createWarning({
                    metadataName: metadataName || 'Unknown',
                    metadataType,
                    category: CATEGORIES.FORMULA_TYPE_CHANGE,
                    message,
                    recommendation:
                        'Destination field type cannot convert to Formula. Create a new formula field or change the destination type before deploy.'
                })
            );
            continue;
        }

        if (
            /invalid field|invalid relationship|unsupported function|compiled formula|formula compilation/i.test(
                message
            )
        ) {
            warnings.push(
                createWarning({
                    metadataName: metadataName || 'Unknown',
                    metadataType,
                    category: CATEGORIES.FORMULA_COMPILATION,
                    message,
                    recommendation:
                        'Deploy referenced picklist changes first or update the formula.'
                })
            );
            continue;
        }

        if (
            /areMetricsLoggedToDataCloud|not valid for type|api version/i.test(
                message
            ) &&
            /flow/i.test(String(metadataType || message))
        ) {
            warnings.push(
                createWarning({
                    metadataName: metadataName || 'Unknown',
                    metadataType: metadataType || 'Flow',
                    category: CATEGORIES.FLOW_API_VERSION,
                    message,
                    recommendation:
                        'Raise the deployment API version or remove unsupported Flow properties before deploy.'
                })
            );
        }
    }

    return warnings;
}

function parseRequiredApiVersion(findings = []) {
    let required = null;

    for (const finding of findings || []) {
        const value = finding?.requiredApiVersion;

        if (!value) {
            continue;
        }

        const numeric = Number.parseFloat(value);

        if (!Number.isNaN(numeric) && (required == null || numeric > required)) {
            required = numeric;
        }
    }

    return required == null ? null : required.toFixed(1);
}

/**
 * Map Phase 13.1 diagnostics into the existing compatibility warning model.
 * Version-gated properties are blockers because removing them changes security.
 * Unknown/malformed XML remains advisory and never blocks by itself.
 */
function mapPermissionSetCompatibilityWarnings(permissionSetCompatibility) {
    const warnings = [];
    const permissionSets = Array.isArray(
        permissionSetCompatibility?.permissionSets
    )
        ? permissionSetCompatibility.permissionSets
        : [];

    for (const diagnostic of permissionSets) {
        const unsupportedProperties = Array.isArray(
            diagnostic?.unsupportedProperties
        )
            ? diagnostic.unsupportedProperties
            : [];
        const unknownNodes = Array.isArray(diagnostic?.unknownNodes)
            ? diagnostic.unknownNodes
            : [];
        const findings = Array.isArray(diagnostic?.compatibilityFindings)
            ? diagnostic.compatibilityFindings
            : [];
        const requiredApi = parseRequiredApiVersion(findings);
        const displayProperties = unsupportedProperties.map((property) =>
            String(property).split('.').pop()
        );

        if (unsupportedProperties.length) {
            warnings.push(
                createWarning({
                    metadataName: diagnostic.permissionSet || null,
                    metadataType: 'PermissionSet',
                    category: CATEGORIES.PERMISSION_SET_API_VERSION,
                    severity: 'BLOCKER',
                    status: 'INCOMPATIBLE',
                    currentApi: diagnostic.detectedApiVersion || null,
                    requiredApi,
                    unsupportedProperties: displayProperties,
                    versionGatedNodes: [...displayProperties],
                    unknownNodes,
                    safeToRemove: false,
                    requiresUserAttention: true,
                    message: `PermissionSet ${diagnostic.permissionSet || 'Unknown'} contains properties unsupported by Metadata API ${diagnostic.detectedApiVersion || 'unknown'}: ${displayProperties.join(', ')}. Automatic removal is unsafe because it changes the security model.`,
                    recommendation:
                        diagnostic.recommendedAction ||
                        `Deploy using Metadata API ${requiredApi || 'a supported version'} or review the PermissionSet security model before deployment.`
                })
            );
            continue;
        }

        if (unknownNodes.length || diagnostic?.malformedXml === true) {
            warnings.push(
                createWarning({
                    metadataName: diagnostic.permissionSet || null,
                    metadataType: 'PermissionSet',
                    category: CATEGORIES.PERMISSION_SET_API_VERSION,
                    severity: 'WARNING',
                    status: 'REVIEW_REQUIRED',
                    currentApi: diagnostic.detectedApiVersion || null,
                    requiredApi: null,
                    unsupportedProperties: [],
                    versionGatedNodes: [],
                    unknownNodes,
                    safeToRemove: false,
                    requiresUserAttention: true,
                    message: diagnostic?.malformedXml
                        ? `PermissionSet ${diagnostic.permissionSet || 'Unknown'} XML is malformed and compatibility could not be determined.`
                        : `PermissionSet ${diagnostic.permissionSet || 'Unknown'} contains unrecognized nodes: ${unknownNodes.join(', ')}.`,
                    recommendation:
                        diagnostic.recommendedAction ||
                        'Review the PermissionSet XML against the destination Metadata API schema.'
                })
            );
        }
    }

    return warnings;
}

function analyzeFlowApiCompatibility(item, content, deploymentApiVersion) {
    const warnings = [];
    const metadataName = getItemName(item);

    if (!content || !metadataName) {
        return warnings;
    }

    const apiVersion =
        deploymentApiVersion != null ? Number(deploymentApiVersion) : null;

    for (const entry of FLOW_API_COMPAT_TAGS) {
        if (!new RegExp(`<${entry.tag}>`, 'i').test(content)) {
            continue;
        }

        if (
            apiVersion != null &&
            !Number.isNaN(apiVersion) &&
            apiVersion >= entry.minimumApiVersion
        ) {
            continue;
        }

        warnings.push(
            createWarning({
                metadataName,
                metadataType: 'Flow',
                category: CATEGORIES.FLOW_API_VERSION,
                message:
                    apiVersion == null
                        ? `Flow ${metadataName} contains ${entry.tag}, which requires API ${entry.minimumApiVersion}+.`
                        : `Flow ${metadataName} property ${entry.tag} is not valid for deployment API version ${apiVersion}.`,
                recommendation:
                    'Raise the deployment API version or remove unsupported Flow properties before deploy.'
            })
        );
    }

    return warnings;
}

function extractLwcComponentNames(content) {
    const names = new Set();
    const source = String(content || '');

    for (const match of source.matchAll(
        /markup:\/\/c:([A-Za-z][\w]*)/gi
    )) {
        names.add(match[1]);
    }

    for (const match of source.matchAll(
        /<c-([a-z][\w-]*)\b/gi
    )) {
        // c-my-component → MyComponent (best-effort camelCase)
        const kebab = match[1];
        const camel = kebab
            .split('-')
            .map((part, index) =>
                index === 0
                    ? part
                    : part.charAt(0).toUpperCase() + part.slice(1)
            )
            .join('');
        const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
        names.add(pascal);
    }

    for (const match of source.matchAll(
        /componentName>\s*([A-Za-z][\w]*)\s*</gi
    )) {
        names.add(match[1]);
    }

    return [...names];
}

function analyzeLwcAndFlexiDependencies(item, content, membership) {
    const warnings = [];
    const metadataName = getItemName(item);
    const metadataType = getItemType(item);

    if (!content || !metadataName) {
        return warnings;
    }

    const referencedComponents = extractLwcComponentNames(content);

    for (const componentName of referencedComponents) {
        if (
            hasPackageMember(
                membership,
                'LightningComponentBundle',
                componentName
            )
        ) {
            continue;
        }

        if (metadataType === 'FlexiPage') {
            warnings.push(
                createWarning({
                    metadataName,
                    metadataType: 'FlexiPage',
                    category: CATEGORIES.FLEXIPAGE_DEPENDENCY,
                    message: `FlexiPage ${metadataName} references Lightning component ${componentName}, which is not in the deployment package.`,
                    recommendation:
                        'Include the Lightning Web Component in the deployment package or remove the FlexiPage reference.'
                })
            );
        } else {
            warnings.push(
                createWarning({
                    metadataName,
                    metadataType: metadataType || 'LightningComponentBundle',
                    category: CATEGORIES.LWC_DEPENDENCY,
                    message: `${metadataType || 'Component'} ${metadataName} references Lightning component markup://c:${componentName}, which is not in the deployment package.`,
                    recommendation:
                        'Include the missing Lightning Web Component in the deployment package before deploy.'
                })
            );
        }
    }

    return warnings;
}

function dedupeWarnings(warnings) {
    const seen = new Set();
    const result = [];

    for (const warning of warnings) {
        const key = [
            warning.category,
            warning.metadataName,
            warning.message
        ].join('|');

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(warning);
    }

    return result;
}

function buildBlockingSummary(blockingComponents = []) {
    const blockingByMetadataType = {};
    const blockingByCategory = {};

    for (const component of blockingComponents || []) {
        const metadataType = component?.metadataType || 'Unknown';
        const category = component?.category || 'UNKNOWN';
        blockingByMetadataType[metadataType] =
            (blockingByMetadataType[metadataType] || 0) + 1;
        blockingByCategory[category] =
            (blockingByCategory[category] || 0) + 1;
    }

    return {
        totalBlocking: blockingComponents.length,
        blockingByMetadataType,
        blockingByCategory
    };
}

function isBlockingCompatibilityFinding(finding) {
    return (
        finding?.status === 'BLOCK' ||
        finding?.status === 'FAIL' ||
        finding?.blocking === true
    );
}

/**
 * Convert Deployment Compatibility Analyzer findings into readiness blockers.
 * Uses the same blocking semantics as deploymentCompatibilityAnalyzer.
 */
function buildBlockingComponentsFromCompatibilityFindings(findings = []) {
    const components = [];
    const seen = new Set();

    for (const finding of findings) {
        if (!isBlockingCompatibilityFinding(finding)) {
            continue;
        }

        const metadataType = finding?.metadataType || finding?.type || null;
        const metadataName = finding?.metadataName || finding?.name || null;

        if (!metadataType || !metadataName) {
            continue;
        }

        const key = `${metadataType}:${metadataName}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        components.push({
            metadataType,
            metadataName,
            action: 'BLOCKING',
            category: finding?.ruleId || 'COMPATIBILITY_ANALYZER',
            severity: finding?.severity || 'BLOCKER',
            status: finding?.status || 'BLOCK',
            reason: finding?.reason || null,
            requiredBy: finding?.requiredBy || null,
            recommendation: finding?.recommendedAction || null
        });
    }

    return components;
}

function mergeCompatibilityBlockingComponents(...collections) {
    const byComponent = new Map();

    for (const collection of collections) {
        for (const component of collection || []) {
            const metadataType =
                component?.metadataType || component?.type || null;
            const metadataName =
                component?.metadataName || component?.name || null;

            if (!metadataType || !metadataName) {
                continue;
            }

            const key = `${metadataType}:${metadataName}`;

            if (!byComponent.has(key)) {
                byComponent.set(key, {
                    ...component,
                    metadataType,
                    metadataName
                });
            }
        }
    }

    return [...byComponent.values()];
}

function buildEmptyResult(reason) {
    return {
        overallStatus: 'PASS',
        compatibilityWarnings: [],
        blockingComponents: [],
        blockingSummary: buildBlockingSummary([]),
        summary: {
            warningCount: 0,
            blockingCount: 0,
            reason: reason || null
        }
    };
}

/**
 * Analyze deployment package / prior validation for destination compatibility risks.
 * Warnings only — never changes deploy behavior.
 */
async function analyzeDeploymentCompatibilityPlan({
    generatedDeploymentPackage,
    formulaCompatibility = null,
    permissionSetCompatibility = null,
    existingFindings = [],
    deploymentApiVersionPolicy = null,
    readFile = null
} = {}) {
    if (!generatedDeploymentPackage) {
        return buildEmptyResult('Generated deployment package not available.');
    }

    const membership = buildPackageMembership(generatedDeploymentPackage);
    const warnings = [];

    warnings.push(...mapFormulaCompatibilityWarnings(formulaCompatibility));
    warnings.push(...mapExistingFindingWarnings(existingFindings));

    // PermissionSet compatibility is fail-safe: analyzer/mapping failures must
    // never create a blocker or affect existing compatibility categories.
    try {
        warnings.push(
            ...mapPermissionSetCompatibilityWarnings(
                permissionSetCompatibility
            )
        );
    } catch (error) {
        // Intentionally empty — existing compatibility planning continues.
    }

    const deploymentApiVersion =
        deploymentApiVersionPolicy?.deploymentApiVersion ||
        deploymentApiVersionPolicy?.apiVersion ||
        null;

    for (const item of membership.items) {
        const type = getItemType(item);
        const content = await readItemContent(item, readFile);

        if (!content) {
            continue;
        }

        if (type === 'Flow') {
            warnings.push(
                ...analyzeFlowApiCompatibility(
                    item,
                    content,
                    deploymentApiVersion
                )
            );
        }

        if (
            type === 'FlexiPage' ||
            type === 'LightningComponentBundle' ||
            type === 'AuraDefinitionBundle'
        ) {
            warnings.push(
                ...analyzeLwcAndFlexiDependencies(item, content, membership)
            );
        }
    }

    const compatibilityWarnings = dedupeWarnings(warnings);

    // TEMP (Phase 13.5) — adoption trace stage 3. Logging only.
    metadataApiAdoptionTrace.logPlannerEvaluationStage({
        deploymentApiVersion,
        compatibilityWarnings
    });

    const blockingComponents = compatibilityWarnings
        .filter(
            (warning) =>
                warning.category === CATEGORIES.PERMISSION_SET_API_VERSION &&
                warning.status === 'INCOMPATIBLE' &&
                warning.severity === 'BLOCKER'
        )
        .map((warning) => ({
            metadataType: warning.metadataType,
            metadataName: warning.metadataName,
            category: warning.category,
            severity: warning.severity,
            status: warning.status,
            action: 'BLOCKING',
            reason: warning.message,
            currentApi: warning.currentApi || null,
            requiredApi: warning.requiredApi || null,
            unsupportedProperties: warning.unsupportedProperties || [],
            recommendation: warning.recommendation
        }));
    const blockingSummary = buildBlockingSummary(blockingComponents);
    const overallStatus = blockingComponents.length
        ? 'INCOMPATIBLE'
        : compatibilityWarnings.length
          ? 'WARNING'
          : 'PASS';

    return {
        overallStatus,
        compatibilityWarnings,
        blockingComponents,
        blockingSummary,
        summary: {
            warningCount: compatibilityWarnings.length,
            blockingCount: blockingComponents.length,
            reason: null
        }
    };
}

module.exports = {
    CATEGORIES,
    analyzeDeploymentCompatibilityPlan,
    mapFormulaCompatibilityWarnings,
    mapPermissionSetCompatibilityWarnings,
    mapExistingFindingWarnings,
    analyzeFlowApiCompatibility,
    extractLwcComponentNames,
    analyzeLwcAndFlexiDependencies,
    buildBlockingSummary,
    isBlockingCompatibilityFinding,
    buildBlockingComponentsFromCompatibilityFindings,
    mergeCompatibilityBlockingComponents
};
