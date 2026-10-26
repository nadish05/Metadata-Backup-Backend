/**
 * CustomField source/destination shape conflict detection (Phase 1).
 *
 * Uses existing shape indexes to detect formula ↔ non-formula definition
 * conflicts before check-only deployment. Warnings carry autoExclude: false
 * unless deploymentPackage.autoExcludeShapeFormulaConflicts is true (Phase 2).
 */

'use strict';

const {
    lookupSourceEntry,
    lookupDestinationEntry,
    buildSideFromSourceEntry,
    buildSideFromDestinationEntry,
    buildComparison
} = require('./aiDeploymentAdvisor/aiResolutionFactPack.service');

const SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR =
    'Cannot update a field from a Formula to something else';

function getItemType(item) {
    return item?.metadataType || item?.type || null;
}

function getItemName(item) {
    return item?.metadataName || item?.name || null;
}

function formatTypeLabel(side) {
    const mdapi = side?.details?.mdapiType;

    if (mdapi) {
        return String(mdapi);
    }

    const type = side?.type;

    if (!type) {
        return 'unknown';
    }

    return String(type);
}

function calculatedFlagLabel(value) {
    if (value === true) {
        return 'formula (calculated)';
    }

    if (value === false) {
        return 'not a formula';
    }

    return 'unknown calculated status';
}

/**
 * Plain-English explanation using verified shape facts only.
 */
function buildShapeConflictMessage(metadataName, source, destination) {
    const sourceType = formatTypeLabel(source);
    const destType = formatTypeLabel(destination);
    const sourceCalc = source.calculated;
    const destCalc = destination.calculated;

    if (sourceCalc === false && destCalc === true) {
        const typeDetail =
            sourceType.toLowerCase() === destType.toLowerCase()
                ? `both report underlying type ${sourceType}`
                : `source type is ${sourceType} but destination reports type ${destType}`;

        return (
            `CustomField ${metadataName}: source metadata defines a ${sourceType} field that is ${calculatedFlagLabel(false)}, ` +
            `but the destination org already has a formula field with the same API name (${typeDetail}, ${calculatedFlagLabel(true)}). ` +
            `Salesforce rejects this deploy with: "${SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR}".`
        );
    }

    if (sourceCalc === true && destCalc === false) {
        return (
            `CustomField ${metadataName}: source metadata defines a formula ${sourceType} field (${calculatedFlagLabel(true)}), ` +
            `but the destination org has a non-formula ${destType} field (${calculatedFlagLabel(false)}). ` +
            `Salesforce does not allow in-place conversion between formula and non-formula field definitions via Metadata API deploy.`
        );
    }

    return (
        `CustomField ${metadataName}: source field (${sourceType}, ${calculatedFlagLabel(sourceCalc)}) ` +
        `does not match the destination field (${destType}, ${calculatedFlagLabel(destCalc)}). ` +
        `Formula and non-formula definitions cannot be swapped in place.`
    );
}

function buildRecommendation(source, destination) {
    if (source.calculated === false && destination.calculated === true) {
        return (
            'Align source metadata with the destination formula field, change the destination field manually in Setup, ' +
            'use a new API name in source, or exclude this field from the deployment package after review. ' +
            'Do not delete production fields without reviewing dependencies.'
        );
    }

    if (source.calculated === true && destination.calculated === false) {
        return (
            'Align source metadata with the destination non-formula field, change the destination field manually in Setup, ' +
            'use a new API name in source, or exclude this field from the deployment package after review.'
        );
    }

    return 'Reconcile source and destination CustomField definitions before deploy.';
}

function hasFormulaCalculatedMismatch(source, destination, comparison) {
    if (comparison?.confidence !== 'HIGH') {
        return false;
    }

    if (
        typeof source.calculated !== 'boolean' ||
        typeof destination.calculated !== 'boolean'
    ) {
        return false;
    }

    return source.calculated !== destination.calculated;
}

function collectPackageCustomFields(generatedDeploymentPackage) {
    const items = [
        ...(generatedDeploymentPackage?.metadata || []),
        ...(generatedDeploymentPackage?.dependencies || [])
    ];
    const seen = new Set();
    const fields = [];

    for (const item of items) {
        const metadataType = getItemType(item);
        const metadataName = getItemName(item);

        if (metadataType !== 'CustomField' || !metadataName) {
            continue;
        }

        const key = `CustomField:${metadataName}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        fields.push({ metadataType, metadataName });
    }

    return fields;
}

/**
 * Detect formula ↔ non-formula CustomField conflicts from shape indexes.
 *
 * @returns {{ warnings: object[] }}
 */
function analyzeCustomFieldShapeCompatibilityConflicts({
    generatedDeploymentPackage,
    sourceShapeIndex = null,
    destinationShapeIndex = null
} = {}) {
    const warnings = [];

    if (!generatedDeploymentPackage) {
        return { warnings };
    }

    if (!sourceShapeIndex && !destinationShapeIndex) {
        return { warnings };
    }

    for (const { metadataType, metadataName } of collectPackageCustomFields(
        generatedDeploymentPackage
    )) {
        const sourceEntry = lookupSourceEntry(
            sourceShapeIndex,
            metadataName
        );
        const destinationEntry = lookupDestinationEntry(
            destinationShapeIndex,
            metadataName
        );
        const source = buildSideFromSourceEntry(sourceEntry);
        const destination = buildSideFromDestinationEntry(destinationEntry);
        const comparison = buildComparison(source, destination);

        if (!hasFormulaCalculatedMismatch(source, destination, comparison)) {
            continue;
        }

        if (destination.exists !== true) {
            continue;
        }

        const message = buildShapeConflictMessage(
            metadataName,
            source,
            destination
        );

        warnings.push({
            metadataType,
            metadataName,
            category: 'FORMULA_TYPE_CHANGE',
            severity: 'WARNING',
            autoExclude: false,
            detectionSource: 'SHAPE_INDEX',
            message,
            recommendation: buildRecommendation(source, destination),
            conflictFacts: {
                conflictType: comparison.conflictType,
                source: {
                    type: formatTypeLabel(source),
                    calculated: source.calculated,
                    label: source.label
                },
                destination: {
                    type: formatTypeLabel(destination),
                    calculated: destination.calculated,
                    label: destination.label
                }
            },
            expectedSalesforceError:
                source.calculated === false && destination.calculated === true
                    ? SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR
                    : null
        });
    }

    return { warnings };
}

module.exports = {
    SALESFORCE_FORMULA_TO_NON_FORMULA_ERROR,
    analyzeCustomFieldShapeCompatibilityConflicts,
    buildShapeConflictMessage
};
