/**
 * Formula Compatibility Validator (Phase 10.23).
 *
 * Read-only analysis of Formula and Roll-Up Summary fields in the
 * generated deployment package. Does not modify packages, planner,
 * workspace, or deployment execution.
 */

const CATEGORIES = Object.freeze({
    MISSING_FIELD: 'MISSING_FIELD',
    MISSING_RELATION: 'MISSING_RELATION',
    PICKLIST_USAGE: 'PICKLIST_USAGE',
    ROLLUP_REFERENCE: 'ROLLUP_REFERENCE',
    FORMULA_CONVERSION: 'FORMULA_CONVERSION'
});

const STANDARD_FIELDS = Object.freeze(
    new Set([
        'Id',
        'Name',
        'OwnerId',
        'CreatedDate',
        'CreatedById',
        'LastModifiedDate',
        'LastModifiedById',
        'SystemModstamp',
        'IsDeleted',
        'RecordTypeId'
    ])
);

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

function extractXmlBlocks(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>[\\s\\S]*?<\\/${tagName}>`,
        'gi'
    );
    return String(content || '').match(pattern) || [];
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
    const items = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];

    for (const item of items) {
        const type = getItemType(item);
        const name = getItemName(item);
        const key = packageKey(type, name);

        if (key) {
            keys.add(key);
        }
    }

    return keys;
}

function hasPackageMember(membership, type, name) {
    return membership.has(packageKey(type, name));
}

function isCustomFieldApiToken(token) {
    if (!token) {
        return false;
    }

    const fieldPart = String(token).includes('.')
        ? String(token).split('.').pop()
        : String(token).trim();

    if (!fieldPart || STANDARD_FIELDS.has(fieldPart)) {
        return false;
    }

    return /__c$/i.test(fieldPart);
}

function isCustomObjectApiName(name) {
    return Boolean(name) && /__c$/i.test(String(name).trim());
}

function resolveSummaryChildObject(fieldXml) {
    const summarizedObject = extractXmlTagValue(fieldXml, 'summarizedObject');

    if (isCustomObjectApiName(summarizedObject)) {
        return summarizedObject;
    }

    const summaryForeignKey = extractXmlTagValue(
        fieldXml,
        'summaryForeignKey'
    );

    if (summaryForeignKey && String(summaryForeignKey).includes('.')) {
        const childObject = String(summaryForeignKey).split('.')[0].trim();

        if (isCustomObjectApiName(childObject)) {
            return childObject;
        }
    }

    return null;
}

function relationshipRefToObjectHeuristic(relationshipRef) {
    const trimmed = String(relationshipRef || '').trim();

    if (!trimmed.toLowerCase().endsWith('__r')) {
        return null;
    }

    const objectName = `${trimmed.slice(0, -3)}__c`;

    return isCustomObjectApiName(objectName) ? objectName : null;
}

function createWarning({
    metadataName,
    metadataType = 'CustomField',
    severity = 'WARNING',
    category,
    message
}) {
    return {
        metadataName,
        metadataType,
        severity,
        category,
        message
    };
}

/**
 * Detect direct picklist comparisons: Field__c = "Open" / == 'Open'
 */
function detectPicklistUsageWarnings(fieldXml, metadataName) {
    const formula = extractXmlTagValue(fieldXml, 'formula');

    if (!formula) {
        return [];
    }

    const warnings = [];
    const pattern =
        /\b([A-Za-z][\w]*__c)\s*(?:={1,2}|<>|!=)\s*(['"])[^'"]*\2/g;

    for (const match of String(formula).matchAll(pattern)) {
        const fieldToken = match[1];

        warnings.push(
            createWarning({
                metadataName,
                category: CATEGORIES.PICKLIST_USAGE,
                message: `Formula ${metadataName} compares ${fieldToken} with a string literal. Prefer ISPICKVAL(${fieldToken}, "...") or TEXT(${fieldToken}) for picklist-safe comparisons.`
            })
        );
    }

    return warnings;
}

/**
 * Collect formula / filter expression field references with categories.
 */
function collectExpressionReferences(fieldXml, ownerObjectApiName) {
    const refs = [];
    const fieldType = extractXmlTagValue(fieldXml, 'type');
    const texts = [];
    const formula = extractXmlTagValue(fieldXml, 'formula');

    if (formula) {
        texts.push(formula);
    }

    for (const block of extractXmlBlocks(fieldXml, 'summaryFilterItems')) {
        const filterField = extractXmlTagValue(block, 'field');

        if (filterField) {
            texts.push(filterField);
        }
    }

    let bareOwner = ownerObjectApiName;

    if (String(fieldType || '') === 'Summary') {
        bareOwner = resolveSummaryChildObject(fieldXml) || ownerObjectApiName;
    }

    for (const text of texts) {
        const expression = String(text || '');

        for (const match of expression.matchAll(
            /\b([A-Za-z][\w]*__r)\.([A-Za-z][\w]*)\b/gi
        )) {
            const relationshipRef = match[1];
            const fieldApiName = match[2];
            const relatedObject =
                relationshipRefToObjectHeuristic(relationshipRef);

            if (!relatedObject) {
                continue;
            }

            refs.push({
                category: CATEGORIES.MISSING_RELATION,
                qualifiedName: `${relatedObject}.${fieldApiName}`,
                isCustom: isCustomFieldApiToken(fieldApiName),
                isStandard: STANDARD_FIELDS.has(fieldApiName),
                relationshipRef,
                fieldApiName
            });
        }

        for (const match of expression.matchAll(
            /\b([A-Za-z][\w]*__c)\.([A-Za-z][\w]*__c)\b/g
        )) {
            refs.push({
                category: CATEGORIES.MISSING_FIELD,
                qualifiedName: `${match[1]}.${match[2]}`,
                isCustom: true,
                isStandard: false
            });
        }

        const stripped = expression
            .replace(/\b[A-Za-z][\w]*__r\.[A-Za-z][\w]*\b/gi, ' ')
            .replace(/\b[A-Za-z][\w]*__c\.[A-Za-z][\w]*__c\b/g, ' ');

        for (const match of stripped.matchAll(/\b([A-Za-z][\w]*__c)\b/g)) {
            const token = match[1];

            if (!isCustomFieldApiToken(token) || token === bareOwner) {
                continue;
            }

            refs.push({
                category: CATEGORIES.MISSING_FIELD,
                qualifiedName: `${bareOwner}.${token}`,
                isCustom: true,
                isStandard: false
            });
        }
    }

    return refs;
}

function analyzeFormulaFieldXml({
    fieldXml,
    metadataName,
    ownerObjectApiName,
    membership
}) {
    const warnings = [];
    const seen = new Set();

    warnings.push(...detectPicklistUsageWarnings(fieldXml, metadataName));

    for (const ref of collectExpressionReferences(
        fieldXml,
        ownerObjectApiName
    )) {
        if (ref.qualifiedName === metadataName) {
            continue;
        }

        // Standard fields exist in the destination org; skip package checks.
        if (ref.isStandard || !ref.isCustom) {
            if (
                ref.category === CATEGORIES.MISSING_RELATION &&
                ref.isStandard
            ) {
                // Related standard fields (e.g. Session__r.Name) are assumed
                // present in the destination; no package warning.
                continue;
            }

            continue;
        }

        if (hasPackageMember(membership, 'CustomField', ref.qualifiedName)) {
            continue;
        }

        const dedupeKey = `${ref.category}:${ref.qualifiedName}`;

        if (seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);

        warnings.push(
            createWarning({
                metadataName,
                category: ref.category,
                message:
                    ref.category === CATEGORIES.MISSING_RELATION
                        ? `Formula ${metadataName} references related field ${ref.qualifiedName} via ${ref.relationshipRef}, which is not in the deployment package.`
                        : `Formula ${metadataName} references ${ref.qualifiedName}, which is not in the deployment package.`
            })
        );
    }

    return warnings;
}

function analyzeSummaryFieldXml({
    fieldXml,
    metadataName,
    ownerObjectApiName,
    membership
}) {
    const warnings = [];
    const childObject = resolveSummaryChildObject(fieldXml);

    const summarizedField = extractXmlTagValue(fieldXml, 'summarizedField');

    if (summarizedField && childObject) {
        const qualified = String(summarizedField).includes('.')
            ? summarizedField
            : `${childObject}.${summarizedField}`;

        if (
            isCustomFieldApiToken(qualified) &&
            !hasPackageMember(membership, 'CustomField', qualified)
        ) {
            warnings.push(
                createWarning({
                    metadataName,
                    category: CATEGORIES.ROLLUP_REFERENCE,
                    message: `Roll-Up Summary ${metadataName} summarizedField ${qualified} is not in the deployment package.`
                })
            );
        }
    }

    const summaryForeignKey = extractXmlTagValue(
        fieldXml,
        'summaryForeignKey'
    );

    if (
        summaryForeignKey &&
        String(summaryForeignKey).includes('.') &&
        isCustomFieldApiToken(summaryForeignKey) &&
        !hasPackageMember(membership, 'CustomField', summaryForeignKey)
    ) {
        warnings.push(
            createWarning({
                metadataName,
                category: CATEGORIES.ROLLUP_REFERENCE,
                message: `Roll-Up Summary ${metadataName} summaryForeignKey ${summaryForeignKey} is not in the deployment package.`
            })
        );
    }

    for (const block of extractXmlBlocks(fieldXml, 'summaryFilterItems')) {
        const filterField = extractXmlTagValue(block, 'field');

        if (!filterField) {
            continue;
        }

        let qualified = filterField;

        if (!String(filterField).includes('.') && childObject) {
            qualified = `${childObject}.${filterField}`;
        }

        if (
            isCustomFieldApiToken(qualified) &&
            !hasPackageMember(membership, 'CustomField', qualified)
        ) {
            warnings.push(
                createWarning({
                    metadataName,
                    category: CATEGORIES.ROLLUP_REFERENCE,
                    message: `Roll-Up Summary ${metadataName} summaryFilterItems field ${qualified} is not in the deployment package.`
                })
            );
        }
    }

    // Expression-style refs inside filters / any embedded formula text.
    for (const ref of collectExpressionReferences(
        fieldXml,
        ownerObjectApiName
    )) {
        if (!ref.isCustom || ref.isStandard) {
            continue;
        }

        if (hasPackageMember(membership, 'CustomField', ref.qualifiedName)) {
            continue;
        }

        // Avoid duplicating ROLLUP_REFERENCE already emitted above.
        const alreadyReported = warnings.some(
            (warning) =>
                warning.category === CATEGORIES.ROLLUP_REFERENCE &&
                warning.message.includes(ref.qualifiedName)
        );

        if (alreadyReported) {
            continue;
        }

        warnings.push(
            createWarning({
                metadataName,
                category: CATEGORIES.ROLLUP_REFERENCE,
                message: `Roll-Up Summary ${metadataName} expression references ${ref.qualifiedName}, which is not in the deployment package.`
            })
        );
    }

    return warnings;
}

function mapFormulaConversionWarnings(existingFindings = []) {
    const warnings = [];
    const findings = Array.isArray(existingFindings) ? existingFindings : [];

    for (const finding of findings) {
        const message = String(
            finding?.message ||
                finding?.problem ||
                finding?.detail ||
                finding ||
                ''
        );

        if (!/cannot update.*to (a )?formula/i.test(message)) {
            continue;
        }

        const metadataName =
            finding?.metadataName ||
            finding?.name ||
            finding?.fullName ||
            null;

        warnings.push(
            createWarning({
                metadataName: metadataName || 'Unknown',
                severity: 'WARNING',
                category: CATEGORIES.FORMULA_CONVERSION,
                message: metadataName
                    ? `Destination reports formula conversion conflict for ${metadataName}: ${message}`
                    : `Destination reports formula conversion conflict: ${message}`
            })
        );
    }

    return warnings;
}

function resolveOwnerObject(item) {
    const name = getItemName(item);

    if (name && String(name).includes('.')) {
        return String(name).split('.')[0];
    }

    const filePath = item?.filePath;

    if (filePath) {
        const match = String(filePath)
            .replace(/\\/g, '/')
            .match(/\/objects\/([^/]+)\//);

        if (match) {
            return match[1];
        }
    }

    return null;
}

async function readItemXml(item, readFile) {
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

function buildEmptyResult(reason) {
    return {
        overallStatus: 'PASS',
        warnings: [],
        summary: {
            analyzed: 0,
            warningCount: 0,
            reason: reason || null
        }
    };
}

/**
 * Analyze Formula / Summary fields in the generated deployment package.
 * Warnings only — never fails validation or mutates the package.
 */
async function analyzeFormulaCompatibility({
    generatedDeploymentPackage,
    readFile = null,
    existingFindings = []
} = {}) {
    if (!generatedDeploymentPackage) {
        return buildEmptyResult('Generated deployment package not available.');
    }

    const membership = buildPackageMembership(generatedDeploymentPackage);
    const items = [
        ...(generatedDeploymentPackage.metadata || []),
        ...(generatedDeploymentPackage.dependencies || [])
    ].filter((item) => getItemType(item) === 'CustomField');

    const warnings = [];
    let analyzed = 0;

    for (const item of items) {
        const metadataName = getItemName(item);

        if (!metadataName) {
            continue;
        }

        const fieldXml = await readItemXml(item, readFile);

        if (!fieldXml) {
            continue;
        }

        const fieldType = extractXmlTagValue(fieldXml, 'type');
        const hasFormula = Boolean(extractXmlTagValue(fieldXml, 'formula'));
        const isFormula =
            String(fieldType || '').toLowerCase() === 'formula' || hasFormula;
        const isSummary = String(fieldType || '') === 'Summary';

        if (!isFormula && !isSummary) {
            continue;
        }

        analyzed += 1;
        const ownerObjectApiName = resolveOwnerObject(item);

        if (isSummary) {
            warnings.push(
                ...analyzeSummaryFieldXml({
                    fieldXml,
                    metadataName,
                    ownerObjectApiName,
                    membership
                })
            );
        } else if (isFormula) {
            warnings.push(
                ...analyzeFormulaFieldXml({
                    fieldXml,
                    metadataName,
                    ownerObjectApiName,
                    membership
                })
            );
        }
    }

    warnings.push(...mapFormulaConversionWarnings(existingFindings));

    const overallStatus = warnings.length ? 'WARNING' : 'PASS';

    return {
        overallStatus,
        warnings,
        summary: {
            analyzed,
            warningCount: warnings.length,
            reason: null
        }
    };
}

module.exports = {
    CATEGORIES,
    analyzeFormulaCompatibility,
    buildPackageMembership,
    detectPicklistUsageWarnings,
    collectExpressionReferences,
    mapFormulaConversionWarnings,
    analyzeFormulaFieldXml,
    analyzeSummaryFieldXml
};
