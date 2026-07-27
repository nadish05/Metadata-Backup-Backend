/**
 * CONTRACT capability evaluator — Phase 9C.
 *
 * Deterministic source vs destination structural comparison.
 * CustomField only. Facts only — does not authorize Skip/Deploy.
 */

const {
    getShapeEntry
} = require('../../destinationShape/destinationShape.model');

const CONTRACT_STATUS = Object.freeze({
    PASS: 'PASS',
    FAIL: 'FAIL',
    UNKNOWN: 'UNKNOWN',
    DEFERRED: 'DEFERRED',
    NOT_EVALUATED: 'NOT_EVALUATED'
});

const CONTRACT_RULE_IDS = Object.freeze({
    FIELD_TYPE: 'FIELD_TYPE',
    LENGTH: 'LENGTH',
    PRECISION: 'PRECISION',
    SCALE: 'SCALE',
    REQUIRED: 'REQUIRED',
    UNIQUE: 'UNIQUE',
    EXTERNAL_ID: 'EXTERNAL_ID',
    REFERENCE_TO: 'REFERENCE_TO',
    PICKLIST_VALUES: 'PICKLIST_VALUES'
});

function buildCapabilityEntry({ status, evidence = {}, reason = null }) {
    return {
        status,
        evidence,
        reason
    };
}

function sameStringArray(left, right) {
    const a = [...(left || [])].map(String).sort();
    const b = [...(right || [])].map(String).sort();

    if (a.length !== b.length) {
        return false;
    }

    return a.every((value, index) => value === b[index]);
}

function activePicklistValues(values) {
    if (!Array.isArray(values)) {
        return null;
    }

    return values
        .filter((entry) => entry && entry.active !== false && entry.value != null)
        .map((entry) => String(entry.value))
        .sort();
}

function compareEqualityRule({
    ruleId,
    label,
    expected,
    actual,
    skipWhenBothNull = true
}) {
    if (expected == null && actual == null) {
        return skipWhenBothNull
            ? { checked: false }
            : {
                  checked: true,
                  pass: true,
                  ruleId,
                  label,
                  expected,
                  actual
              };
    }

    if (expected == null || actual == null) {
        return {
            checked: true,
            pass: false,
            ruleId,
            label,
            expected,
            actual,
            message: `${label}: insufficient values to compare (expected=${expected}, actual=${actual}).`
        };
    }

    const pass = expected === actual;

    return {
        checked: true,
        pass,
        ruleId,
        label,
        expected,
        actual,
        message: pass
            ? null
            : `${label} mismatch: expected ${JSON.stringify(
                  expected
              )}, actual ${JSON.stringify(actual)}.`
    };
}

/**
 * Evaluate CustomField CONTRACT rules.
 *
 * @param {object} params
 * @param {object|null} params.sourceAttributes
 * @param {object|null} params.destinationAttributes
 * @returns {{
 *   status: string,
 *   reason: string,
 *   rulesChecked: string[],
 *   mismatches: object[],
 *   sourceSummary: object|null,
 *   destinationSummary: object|null
 * }}
 */
function evaluateCustomFieldContractRules({
    sourceAttributes = null,
    destinationAttributes = null
} = {}) {
    const rulesChecked = [];
    const mismatches = [];

    if (!sourceAttributes || !destinationAttributes) {
        return {
            status: CONTRACT_STATUS.UNKNOWN,
            reason: 'Insufficient source or destination structural facts for CONTRACT.',
            rulesChecked,
            mismatches,
            sourceSummary: sourceAttributes,
            destinationSummary: destinationAttributes
        };
    }

    const results = [];

    results.push(
        compareEqualityRule({
            ruleId: CONTRACT_RULE_IDS.FIELD_TYPE,
            label: 'Field Type',
            expected: sourceAttributes.type,
            actual: destinationAttributes.type,
            skipWhenBothNull: false
        })
    );

    // Length / precision / scale: compare when source declares a value.
    if (sourceAttributes.length != null) {
        results.push(
            compareEqualityRule({
                ruleId: CONTRACT_RULE_IDS.LENGTH,
                label: 'Length',
                expected: sourceAttributes.length,
                actual: destinationAttributes.length
            })
        );
    }

    if (sourceAttributes.precision != null) {
        results.push(
            compareEqualityRule({
                ruleId: CONTRACT_RULE_IDS.PRECISION,
                label: 'Precision',
                expected: sourceAttributes.precision,
                actual: destinationAttributes.precision
            })
        );
    }

    if (sourceAttributes.scale != null) {
        results.push(
            compareEqualityRule({
                ruleId: CONTRACT_RULE_IDS.SCALE,
                label: 'Scale',
                expected: sourceAttributes.scale,
                actual: destinationAttributes.scale
            })
        );
    }

    if (sourceAttributes.required != null) {
        results.push(
            compareEqualityRule({
                ruleId: CONTRACT_RULE_IDS.REQUIRED,
                label: 'Required',
                expected: sourceAttributes.required === true,
                actual: destinationAttributes.required === true
            })
        );
    }

    if (sourceAttributes.unique != null) {
        results.push(
            compareEqualityRule({
                ruleId: CONTRACT_RULE_IDS.UNIQUE,
                label: 'Unique',
                expected: sourceAttributes.unique === true,
                actual: destinationAttributes.unique === true
            })
        );
    }

    if (sourceAttributes.externalId != null) {
        results.push(
            compareEqualityRule({
                ruleId: CONTRACT_RULE_IDS.EXTERNAL_ID,
                label: 'External ID',
                expected: sourceAttributes.externalId === true,
                actual: destinationAttributes.externalId === true
            })
        );
    }

    if (
        sourceAttributes.type === 'reference' ||
        (Array.isArray(sourceAttributes.referenceTo) &&
            sourceAttributes.referenceTo.length > 0)
    ) {
        const expectedRefs = sourceAttributes.referenceTo || [];
        const actualRefs = destinationAttributes.referenceTo || [];
        const pass = sameStringArray(expectedRefs, actualRefs);

        results.push({
            checked: true,
            pass,
            ruleId: CONTRACT_RULE_IDS.REFERENCE_TO,
            label: 'ReferenceTo',
            expected: expectedRefs,
            actual: actualRefs,
            message: pass
                ? null
                : `ReferenceTo mismatch: expected ${JSON.stringify(
                      expectedRefs
                  )}, actual ${JSON.stringify(actualRefs)}.`
        });
    }

    const sourcePicklist = activePicklistValues(sourceAttributes.picklistValues);
    const destPicklist = activePicklistValues(
        destinationAttributes.picklistValues
    );

    if (sourcePicklist && sourcePicklist.length) {
        if (!destPicklist) {
            results.push({
                checked: true,
                pass: false,
                ruleId: CONTRACT_RULE_IDS.PICKLIST_VALUES,
                label: 'Picklist Values',
                expected: sourcePicklist,
                actual: null,
                message:
                    'Picklist value set: destination picklist values unavailable.'
            });
        } else {
            const missing = sourcePicklist.filter(
                (value) => !destPicklist.includes(value)
            );
            const pass = missing.length === 0;

            results.push({
                checked: true,
                pass,
                ruleId: CONTRACT_RULE_IDS.PICKLIST_VALUES,
                label: 'Picklist Values',
                expected: sourcePicklist,
                actual: destPicklist,
                message: pass
                    ? null
                    : `Picklist values missing in destination: ${JSON.stringify(
                          missing
                      )}.`
            });
        }
    }

    for (const result of results) {
        if (!result.checked) {
            continue;
        }

        rulesChecked.push(result.ruleId);

        if (!result.pass) {
            mismatches.push({
                ruleId: result.ruleId,
                label: result.label,
                expected: result.expected,
                actual: result.actual,
                message: result.message
            });
        }
    }

    if (rulesChecked.length === 0) {
        return {
            status: CONTRACT_STATUS.UNKNOWN,
            reason: 'No CONTRACT rules were applicable for this CustomField.',
            rulesChecked,
            mismatches,
            sourceSummary: sourceAttributes,
            destinationSummary: destinationAttributes
        };
    }

    if (mismatches.length > 0) {
        return {
            status: CONTRACT_STATUS.FAIL,
            reason: `CONTRACT failed: ${mismatches
                .map((item) => item.message || item.ruleId)
                .join(' ')}`,
            rulesChecked,
            mismatches,
            sourceSummary: sourceAttributes,
            destinationSummary: destinationAttributes
        };
    }

    return {
            status: CONTRACT_STATUS.PASS,
        reason: 'All evaluated CONTRACT rules satisfied.',
        rulesChecked,
        mismatches,
        sourceSummary: sourceAttributes,
        destinationSummary: destinationAttributes
    };
}

/**
 * Evaluate CONTRACT capability for one metadata row.
 *
 * @param {object} params
 * @param {string|null} params.metadataType
 * @param {string|null} params.metadataName
 * @param {boolean|null} params.existsInDestination
 * @param {object|null} params.destinationShapeIndex
 * @param {Map<string, object>|object|null} params.sourceShapeIndex
 * @returns {{ status: string, evidence: object, reason: string }}
 */
function evaluateContractCapability({
    metadataType = null,
    metadataName = null,
    existsInDestination = null,
    destinationShapeIndex = null,
    sourceShapeIndex = null
} = {}) {
    if (metadataType !== 'CustomField') {
        return buildCapabilityEntry({
            status: CONTRACT_STATUS.NOT_EVALUATED,
            evidence: {},
            reason: 'CONTRACT capability is not evaluated for this metadata type.'
        });
    }

    if (existsInDestination !== true) {
        return buildCapabilityEntry({
            status: CONTRACT_STATUS.DEFERRED,
            evidence: {
                rulesChecked: [],
                mismatches: [],
                sourceSummary: null,
                destinationSummary: null,
                existsInDestination
            },
            reason:
                'CONTRACT deferred facts: destination existence is not EXISTS.'
        });
    }

    const sourceEntry = getSourceShapeEntry(sourceShapeIndex, metadataName);
    const destinationEntry = getShapeEntry(
        destinationShapeIndex,
        'CustomField',
        metadataName
    );

    if (!sourceEntry?.attributes) {
        return buildCapabilityEntry({
            status: CONTRACT_STATUS.DEFERRED,
            evidence: {
                rulesChecked: [],
                mismatches: [],
                sourceSummary: sourceEntry || null,
                destinationSummary: destinationEntry || null
            },
            reason: 'CONTRACT DEFERRED: source CustomField structure unavailable.'
        });
    }

    if (!destinationEntry?.found || !destinationEntry?.attributes) {
        return buildCapabilityEntry({
            status: CONTRACT_STATUS.DEFERRED,
            evidence: {
                rulesChecked: [],
                mismatches: [],
                sourceSummary: sourceEntry.attributes,
                destinationSummary: destinationEntry || null
            },
            reason:
                'CONTRACT DEFERRED: destination CustomField shape unavailable.'
        });
    }

    const evaluation = evaluateCustomFieldContractRules({
        sourceAttributes: sourceEntry.attributes,
        destinationAttributes: destinationEntry.attributes
    });

    return buildCapabilityEntry({
        status: evaluation.status,
        reason: evaluation.reason,
        evidence: {
            rulesChecked: evaluation.rulesChecked,
            mismatches: evaluation.mismatches,
            sourceSummary: evaluation.sourceSummary,
            destinationSummary: evaluation.destinationSummary
        }
    });
}

function getSourceShapeEntry(sourceShapeIndex, metadataName) {
    if (!metadataName) {
        return null;
    }

    if (sourceShapeIndex instanceof Map) {
        return (
            sourceShapeIndex.get(`CustomField:${metadataName}`) ||
            sourceShapeIndex.get(metadataName) ||
            null
        );
    }

    if (sourceShapeIndex && typeof sourceShapeIndex === 'object') {
        return (
            sourceShapeIndex[`CustomField:${metadataName}`] ||
            sourceShapeIndex[metadataName] ||
            sourceShapeIndex?.CustomField?.[metadataName] ||
            null
        );
    }

    return null;
}

module.exports = {
    CONTRACT_RULE_IDS,
    evaluateContractCapability,
    evaluateCustomFieldContractRules
};
