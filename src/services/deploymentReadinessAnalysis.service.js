/**
 * Deployment Readiness Analysis (Phase 10.9).
 *
 * Static, report-only pre-deploy risk analysis.
 * Does NOT modify packages, block deployment, or query the destination org.
 */

const {
    analyzeApexContent
} = require('./deploymentReview/dependencyAnalyzer.service');
const {
    extract: extractApexImports
} = require('./dependencyResolution/graphExpansion/extractors/apexImport.extractor');

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

function uniqueStrings(values) {
    return [...new Set((values || []).filter(Boolean))];
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

    return `${type}:${name}`;
}

/**
 * Build membership index from generated deployment package members.
 */
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

        if (!type || !name) {
            continue;
        }

        keys.add(packageKey(type, name));

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

function parseObjectFromCustomFieldName(fieldName) {
    if (!fieldName || !String(fieldName).includes('.')) {
        return null;
    }

    return String(fieldName).split('.')[0] || null;
}

function extractCustomObjectTokens(text) {
    if (!text) {
        return [];
    }

    return uniqueStrings(String(text).match(/\b[A-Za-z][\w]*__c\b/g) || []);
}

/**
 * Roll-Up Summary → required parent/related CustomObjects from summaryForeignKey.
 */
function analyzeRollUpSummaryField(fieldItem, fieldXml, membership) {
    const findings = [];
    const fieldType = extractXmlTagValue(fieldXml, 'type');

    if (String(fieldType || '').toLowerCase() !== 'summary') {
        return findings;
    }

    const fieldName = getItemName(fieldItem);
    const summaryForeignKey = extractXmlTagValue(fieldXml, 'summaryForeignKey');
    const parentObject = parseObjectFromCustomFieldName(fieldName);
    const referencedObjects = extractCustomObjectTokens(summaryForeignKey).filter(
        (objectApiName) => objectApiName !== parentObject
    );

    for (const objectApiName of referencedObjects) {
        if (hasPackageMember(membership, 'CustomObject', objectApiName)) {
            continue;
        }

        findings.push({
            rule: 'ROLLUP_SUMMARY_PARENT',
            severity: 'FAIL',
            category: 'missingDependencies',
            code: 'Missing Parent Object',
            metadataType: 'CustomField',
            metadataName: fieldName,
            missingType: 'CustomObject',
            missingName: objectApiName,
            message: `Roll-Up Summary field ${fieldName} requires CustomObject ${objectApiName} (summaryForeignKey), which is not in the deployment package.`,
            evidence: {
                summaryForeignKey,
                fieldType: 'Summary'
            }
        });
    }

    return findings;
}

/**
 * Formula fields → referenced CustomFields missing from package.
 */
function analyzeFormulaField(fieldItem, fieldXml, membership) {
    const findings = [];
    const fieldType = extractXmlTagValue(fieldXml, 'type');
    const formula = extractXmlTagValue(fieldXml, 'formula');

    if (!formula) {
        return findings;
    }

    const isFormulaType =
        String(fieldType || '').toLowerCase() === 'formula' ||
        Boolean(formula);

    if (!isFormulaType) {
        return findings;
    }

    const fieldName = getItemName(fieldItem);
    const parentObject = parseObjectFromCustomFieldName(fieldName);
    const referenced = new Set();

    for (const match of String(formula).matchAll(
        /\b([A-Za-z][\w]*__c)\.([A-Za-z][\w]*__c)\b/g
    )) {
        referenced.add(`${match[1]}.${match[2]}`);
    }

    // Bare CustomField tokens only — strip already-qualified Object.Field pairs
    // so object API names are not mistaken for same-object fields.
    const formulaWithoutQualified = String(formula).replace(
        /\b[A-Za-z][\w]*__c\.[A-Za-z][\w]*__c\b/g,
        ' '
    );

    for (const match of formulaWithoutQualified.matchAll(
        /\b([A-Za-z][\w]*__c)\b/g
    )) {
        const token = match[1];

        if (!parentObject || token === parentObject) {
            continue;
        }

        referenced.add(`${parentObject}.${token}`);
    }

    for (const referencedField of referenced) {
        if (referencedField === fieldName) {
            continue;
        }

        if (hasPackageMember(membership, 'CustomField', referencedField)) {
            continue;
        }

        // Object-only tokens accidentally captured are skipped if they look like objects only.
        if (!String(referencedField).includes('.')) {
            continue;
        }

        findings.push({
            rule: 'FORMULA_FIELD_DEPENDENCY',
            severity: 'WARNING',
            category: 'missingDependencies',
            code: 'Missing Formula Dependency',
            metadataType: 'CustomField',
            metadataName: fieldName,
            missingType: 'CustomField',
            missingName: referencedField,
            message: `Formula field ${fieldName} references ${referencedField}, which is not in the deployment package.`,
            evidence: {
                fieldType: fieldType || 'Formula'
            }
        });
    }

    return findings;
}

function collectPredictedFailingFields(findings) {
    const failing = new Set();

    for (const finding of findings) {
        if (
            finding.metadataType === 'CustomField' &&
            finding.metadataName &&
            (finding.severity === 'FAIL' ||
                finding.rule === 'ROLLUP_SUMMARY_PARENT' ||
                finding.rule === 'FORMULA_FIELD_DEPENDENCY')
        ) {
            failing.add(finding.metadataName);
        }

        if (
            finding.missingType === 'CustomField' &&
            finding.missingName &&
            finding.rule === 'FORMULA_FIELD_DEPENDENCY'
        ) {
            // Dependent formula may still deploy, but referenced missing field is a risk.
            failing.add(finding.metadataName);
        }
    }

    return failing;
}

async function readItemContent(item, readFile) {
    if (typeof item?.content === 'string' && item.content.length) {
        return item.content;
    }

    if (typeof item?.metaXmlContent === 'string' && item.metaXmlContent.length) {
        return item.metaXmlContent;
    }

    if (item?.filePath && typeof readFile === 'function') {
        try {
            return await readFile(item.filePath);
        } catch (error) {
            return null;
        }
    }

    return null;
}

async function analyzeCustomFieldRules(membership, readFile) {
    const findings = [];
    const fields = membership.byType.get('CustomField') || [];

    for (const fieldItem of fields) {
        const xml = await readItemContent(fieldItem, readFile);

        if (!xml) {
            continue;
        }

        findings.push(
            ...analyzeRollUpSummaryField(fieldItem, xml, membership),
            ...analyzeFormulaField(fieldItem, xml, membership)
        );
    }

    return findings;
}

async function analyzeApexBlockedByFields(
    membership,
    predictedFailingFields,
    readFile
) {
    const findings = [];
    const apexClasses = membership.byType.get('ApexClass') || [];

    if (!predictedFailingFields.size) {
        return findings;
    }

    for (const apexItem of apexClasses) {
        const content = await readItemContent(apexItem, readFile);

        if (!content) {
            continue;
        }

        const className = getItemName(apexItem);
        const analysis = analyzeApexContent(content, className);
        const blockingFields = (analysis.customFields || []).filter((field) =>
            predictedFailingFields.has(field)
        );

        if (!blockingFields.length) {
            continue;
        }

        findings.push({
            rule: 'APEX_BLOCKED_BY_FIELD',
            severity: 'FAIL',
            category: 'blockingComponents',
            code: 'Blocked Apex Compilation',
            metadataType: 'ApexClass',
            metadataName: className,
            blockedBy: blockingFields,
            message: `Apex class ${className} references field(s) predicted to fail: ${blockingFields.join(
                ', '
            )}.`,
            evidence: {
                referencedCustomFields: analysis.customFields || []
            }
        });
    }

    return findings;
}

function resolveLwcJsFileCandidates(componentItem, repoFiles) {
    const componentName = getItemName(componentItem);
    const candidates = [];

    if (!componentName) {
        return candidates;
    }

    const fromRepo = (repoFiles || [])
        .map((filePath) => String(filePath).replace(/\\/g, '/'))
        .filter(
            (filePath) =>
                filePath.includes(`/lwc/${componentName}/`) &&
                filePath.endsWith('.js') &&
                !filePath.includes('/__tests__/')
        );

    candidates.push(...fromRepo);

    const filePath = String(componentItem?.filePath || '').replace(/\\/g, '/');

    if (filePath.includes(`/lwc/${componentName}`)) {
        const directoryMatch = filePath.match(
            new RegExp(`^(.*\/lwc\/${componentName})(?:\/|$)`)
        );

        if (directoryMatch) {
            candidates.push(`${directoryMatch[1]}/${componentName}.js`);
        }
    }

    return uniqueStrings(candidates);
}

async function analyzeLwcBlockedByApex(
    membership,
    blockedApexNames,
    readFile,
    repoFiles
) {
    const findings = [];
    const components = membership.byType.get('LightningComponentBundle') || [];

    if (!blockedApexNames.size) {
        return findings;
    }

    for (const componentItem of components) {
        const componentName = getItemName(componentItem);
        const jsFiles = resolveLwcJsFileCandidates(componentItem, repoFiles);
        const referencedApex = new Set();

        if (jsFiles.length && typeof readFile === 'function') {
            for (const filePath of jsFiles) {
                try {
                    const source = await readFile(filePath);
                    for (const entry of extractApexImports(source)) {
                        if (entry?.name) {
                            referencedApex.add(entry.name);
                        }
                    }
                } catch (error) {
                    // Skip unreadable files — report-only analyzer.
                }
            }
        }

        if (!referencedApex.size) {
            const content = await readItemContent(componentItem, readFile);

            if (content) {
                for (const entry of extractApexImports(content)) {
                    if (entry?.name) {
                        referencedApex.add(entry.name);
                    }
                }
            }
        }

        const blockedRefs = [...referencedApex].filter((name) =>
            blockedApexNames.has(name)
        );

        if (!blockedRefs.length) {
            continue;
        }

        findings.push({
            rule: 'LWC_BLOCKED_BY_APEX',
            severity: 'FAIL',
            category: 'blockingComponents',
            code: 'Blocked Lightning Component',
            metadataType: 'LightningComponentBundle',
            metadataName: componentName,
            blockedBy: blockedRefs,
            message: `Lightning component ${componentName} depends on blocked Apex class(es): ${blockedRefs.join(
                ', '
            )}.`,
            evidence: {
                referencedApexClasses: [...referencedApex]
            }
        });
    }

    return findings;
}

function analyzeFlexiPageBlockedByComponents(
    membership,
    discoveredReferences,
    blockedLwcNames
) {
    const findings = [];

    if (!blockedLwcNames.size) {
        return findings;
    }

    const flexiPages = membership.byType.get('FlexiPage') || [];
    const references = Array.isArray(discoveredReferences)
        ? discoveredReferences
        : [];

    for (const flexiPageItem of flexiPages) {
        const flexiPageName = getItemName(flexiPageItem);
        const relatedLwcs = references.filter(
            (reference) =>
                (reference.metadataType === 'LightningComponentBundle' ||
                    reference.type === 'LightningComponentBundle') &&
                (reference.sourceMetadata === flexiPageName ||
                    reference.sourceMetadataName === flexiPageName)
        );

        const blockedRefs = relatedLwcs
            .map((reference) => reference.name || reference.metadataName)
            .filter((name) => blockedLwcNames.has(name));

        if (!blockedRefs.length) {
            continue;
        }

        findings.push({
            rule: 'FLEXIPAGE_BLOCKED_BY_LWC',
            severity: 'FAIL',
            category: 'blockingComponents',
            code: 'Blocked FlexiPage',
            metadataType: 'FlexiPage',
            metadataName: flexiPageName,
            blockedBy: uniqueStrings(blockedRefs),
            message: `FlexiPage ${flexiPageName} references blocked Lightning component(s): ${uniqueStrings(
                blockedRefs
            ).join(', ')}.`,
            evidence: {
                referencedComponents: relatedLwcs.map(
                    (reference) => reference.name || reference.metadataName
                )
            }
        });
    }

    return findings;
}

async function analyzeFlowApiCompatibility(
    membership,
    deploymentApiVersionPolicy,
    readFile
) {
    const findings = [];
    const flows = membership.byType.get('Flow') || [];
    const deployVersion = Number(
        deploymentApiVersionPolicy?.deploymentApiVersion ||
            deploymentApiVersionPolicy?.selectedApiVersion ||
            0
    );

    for (const flowItem of flows) {
        const xml = await readItemContent(flowItem, readFile);

        if (!xml) {
            continue;
        }

        const flowName = getItemName(flowItem);

        for (const rule of FLOW_API_COMPAT_TAGS) {
            if (!new RegExp(`<${rule.tag}>`, 'i').test(xml)) {
                continue;
            }

            if (
                Number.isFinite(deployVersion) &&
                deployVersion > 0 &&
                deployVersion >= rule.minimumApiVersion
            ) {
                continue;
            }

            findings.push({
                rule: 'FLOW_API_COMPATIBILITY',
                severity: 'WARNING',
                category: 'apiCompatibilityWarnings',
                code: 'API Compatibility Warning',
                metadataType: 'Flow',
                metadataName: flowName,
                message:
                    rule.message +
                    (deployVersion
                        ? ` Deployment API version: ${deployVersion}.`
                        : ''),
                evidence: {
                    property: rule.tag,
                    minimumApiVersion: rule.minimumApiVersion,
                    deploymentApiVersion: deployVersion || null
                }
            });
        }
    }

    return findings;
}

/**
 * Framework placeholder for future destination schema comparison.
 * This phase does not query destination metadata.
 */
function buildSchemaConflictPlaceholders(options = {}) {
    const prior = Array.isArray(options.priorSchemaConflicts)
        ? options.priorSchemaConflicts
        : [];

    return prior.map((entry) => ({
        rule: 'SCHEMA_CONFLICT_PLACEHOLDER',
        severity: entry.severity || 'WARNING',
        category: 'schemaConflicts',
        code: 'Potential Schema Conflict',
        metadataType: entry.metadataType || null,
        metadataName: entry.metadataName || null,
        message:
            entry.message ||
            'Potential schema conflict detected (framework placeholder).',
        evidence: entry.evidence || null
    }));
}

function buildDependencyChains(findings) {
    const chains = [];
    const byName = new Map();

    for (const finding of findings) {
        if (finding.metadataName) {
            byName.set(`${finding.metadataType}:${finding.metadataName}`, finding);
        }
    }

    for (const finding of findings) {
        if (finding.rule !== 'ROLLUP_SUMMARY_PARENT') {
            continue;
        }

        const chain = [
            {
                step: finding.metadataName,
                detail: finding.code
            },
            {
                step: finding.missingName,
                detail: 'Missing from package'
            }
        ];

        for (const blocked of findings) {
            if (
                blocked.rule === 'APEX_BLOCKED_BY_FIELD' &&
                Array.isArray(blocked.blockedBy) &&
                blocked.blockedBy.includes(finding.metadataName)
            ) {
                chain.push({
                    step: blocked.metadataName,
                    detail: blocked.code
                });

                for (const lwc of findings) {
                    if (
                        lwc.rule === 'LWC_BLOCKED_BY_APEX' &&
                        Array.isArray(lwc.blockedBy) &&
                        lwc.blockedBy.includes(blocked.metadataName)
                    ) {
                        chain.push({
                            step: lwc.metadataName,
                            detail: lwc.code
                        });

                        for (const page of findings) {
                            if (
                                page.rule === 'FLEXIPAGE_BLOCKED_BY_LWC' &&
                                Array.isArray(page.blockedBy) &&
                                page.blockedBy.includes(lwc.metadataName)
                            ) {
                                chain.push({
                                    step: page.metadataName,
                                    detail: page.code
                                });
                            }
                        }
                    }
                }
            }
        }

        chains.push({
            root: finding.metadataName,
            steps: chain,
            rendered: chain.map((entry) => entry.step).join(' → ')
        });
    }

    return chains;
}

function buildRecommendations(findings) {
    const recommendations = [];

    for (const finding of findings) {
        if (finding.rule === 'ROLLUP_SUMMARY_PARENT') {
            recommendations.push(
                `Add CustomObject ${finding.missingName} to the deployment package before deploying ${finding.metadataName}.`
            );
        }

        if (finding.rule === 'FORMULA_FIELD_DEPENDENCY') {
            recommendations.push(
                `Include CustomField ${finding.missingName} required by formula ${finding.metadataName}.`
            );
        }

        if (finding.rule === 'APEX_BLOCKED_BY_FIELD') {
            recommendations.push(
                `Resolve field dependency failures before compiling Apex class ${finding.metadataName}.`
            );
        }

        if (finding.rule === 'LWC_BLOCKED_BY_APEX') {
            recommendations.push(
                `Unblock Apex dependencies before deploying Lightning component ${finding.metadataName}.`
            );
        }

        if (finding.rule === 'FLEXIPAGE_BLOCKED_BY_LWC') {
            recommendations.push(
                `Unblock Lightning component dependencies before deploying FlexiPage ${finding.metadataName}.`
            );
        }

        if (finding.rule === 'FLOW_API_COMPATIBILITY') {
            recommendations.push(
                `Raise the deployment API version or remove unsupported Flow properties on ${finding.metadataName}.`
            );
        }
    }

    return uniqueStrings(recommendations);
}

function resolveOverallStatus(findings) {
    if (!findings.length) {
        return 'PASS';
    }

    if (findings.some((finding) => finding.severity === 'FAIL')) {
        return 'FAIL';
    }

    return 'WARNING';
}

function buildEmptyAnalysis(reason = 'No package members to analyze.') {
    return {
        overallStatus: 'PASS',
        summary: {
            analyzedMembers: 0,
            missingDependencyCount: 0,
            blockingComponentCount: 0,
            apiWarningCount: 0,
            schemaConflictCount: 0,
            reason
        },
        schemaConflicts: [],
        missingDependencies: [],
        dependencyChains: [],
        apiCompatibilityWarnings: [],
        blockingComponents: [],
        recommendations: [],
        findings: []
    };
}

/**
 * Run static deployment readiness analysis.
 *
 * @param {{
 *   generatedDeploymentPackage?: object,
 *   discoveredReferences?: Array,
 *   deploymentApiVersionPolicy?: object|null,
 *   readFile?: (filePath: string) => Promise<string>,
 *   repoFiles?: string[],
 *   priorSchemaConflicts?: Array
 * }} options
 */
async function analyzeDeploymentReadiness(options = {}) {
    const generatedDeploymentPackage = options.generatedDeploymentPackage;
    const membership = buildPackageMembership(generatedDeploymentPackage);

    if (!membership.items.length) {
        return buildEmptyAnalysis();
    }

    const readFile = options.readFile || null;
    const repoFiles = options.repoFiles || [];

    const fieldFindings = await analyzeCustomFieldRules(membership, readFile);
    const predictedFailingFields = collectPredictedFailingFields(fieldFindings);

    const apexFindings = await analyzeApexBlockedByFields(
        membership,
        predictedFailingFields,
        readFile
    );
    const blockedApexNames = new Set(
        apexFindings.map((finding) => finding.metadataName).filter(Boolean)
    );

    const lwcFindings = await analyzeLwcBlockedByApex(
        membership,
        blockedApexNames,
        readFile,
        repoFiles
    );
    const blockedLwcNames = new Set(
        lwcFindings.map((finding) => finding.metadataName).filter(Boolean)
    );

    const flexiFindings = analyzeFlexiPageBlockedByComponents(
        membership,
        options.discoveredReferences || [],
        blockedLwcNames
    );

    const flowFindings = await analyzeFlowApiCompatibility(
        membership,
        options.deploymentApiVersionPolicy || null,
        readFile
    );

    const schemaConflicts = buildSchemaConflictPlaceholders({
        priorSchemaConflicts: options.priorSchemaConflicts
    });

    const findings = [
        ...fieldFindings,
        ...apexFindings,
        ...lwcFindings,
        ...flexiFindings,
        ...flowFindings,
        ...schemaConflicts
    ];

    const missingDependencies = findings.filter(
        (finding) => finding.category === 'missingDependencies'
    );
    const blockingComponents = findings.filter(
        (finding) => finding.category === 'blockingComponents'
    );
    const apiCompatibilityWarnings = findings.filter(
        (finding) => finding.category === 'apiCompatibilityWarnings'
    );

    const overallStatus = resolveOverallStatus(findings);

    return {
        overallStatus,
        summary: {
            analyzedMembers: membership.items.length,
            missingDependencyCount: missingDependencies.length,
            blockingComponentCount: blockingComponents.length,
            apiWarningCount: apiCompatibilityWarnings.length,
            schemaConflictCount: schemaConflicts.length,
            predictedFailingFieldCount: predictedFailingFields.size
        },
        schemaConflicts,
        missingDependencies,
        dependencyChains: buildDependencyChains(findings),
        apiCompatibilityWarnings,
        blockingComponents,
        recommendations: buildRecommendations(findings),
        findings
    };
}

module.exports = {
    analyzeDeploymentReadiness,
    buildPackageMembership,
    analyzeRollUpSummaryField,
    analyzeFormulaField,
    analyzeFlexiPageBlockedByComponents,
    buildSchemaConflictPlaceholders,
    buildDependencyChains,
    buildEmptyAnalysis,
    FLOW_API_COMPAT_TAGS
};
