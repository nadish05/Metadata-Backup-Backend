/**
 * Salesforce Metadata API relationships for StandardValueSet.
 *
 * A StandardValueSet is the standard picklist *definition* (member name),
 * not an individual picklist value. RecordType <values><fullName> entries
 * such as "Ads" are never StandardValueSet members.
 *
 * RecordType XML:
 *   <picklistValues><picklist>LeadSource</picklist>...</picklistValues>
 *   → StandardValueSet:LeadSource
 *
 * BusinessProcess:
 *   Salesforce allows BusinessProcess only on Lead, Opportunity, Case, and
 *   Solution. Each object's process values belong to that object's
 *   stage/status StandardValueSet.
 *
 * Add future supported standard picklists here only. Do not scatter
 * object/field conditionals across discoverers.
 */

/**
 * RecordType <picklist> field API name → StandardValueSet member.
 * Used when the field name uniquely identifies one StandardValueSet.
 */
const PICKLIST_FIELD_TO_STANDARD_VALUE_SET = Object.freeze({
    AccountSource: 'AccountSource',
    LeadSource: 'LeadSource',
    StageName: 'OpportunityStage',
    Industry: 'Industry'
});

/**
 * Object-qualified RecordType picklist field → StandardValueSet member.
 * Used when the field API name is shared across objects (Status, Type, …).
 */
const OBJECT_FIELD_TO_STANDARD_VALUE_SET = Object.freeze({
    'Account.AccountSource': 'AccountSource',
    'Account.Rating': 'AccountRating',
    'Account.Type': 'AccountType',
    'Case.Origin': 'CaseOrigin',
    'Case.Priority': 'CasePriority',
    'Case.Reason': 'CaseReason',
    'Case.Status': 'CaseStatus',
    'Case.Type': 'CaseType',
    'Lead.Industry': 'Industry',
    'Lead.Rating': 'LeadRating',
    'Lead.Status': 'LeadStatus',
    'Opportunity.LeadSource': 'LeadSource',
    'Opportunity.StageName': 'OpportunityStage',
    'Opportunity.Type': 'OpportunityType',
    'Solution.Status': 'SolutionStatus'
});

/**
 * BusinessProcess parent object → StandardValueSet that owns process values.
 * This is the complete Salesforce BusinessProcess object set.
 */
const BUSINESS_PROCESS_OBJECT_TO_STANDARD_VALUE_SET = Object.freeze({
    Case: 'CaseStatus',
    Lead: 'LeadStatus',
    Opportunity: 'OpportunityStage',
    Solution: 'SolutionStatus'
});

function normalizeApiName(value) {
    return String(value || '').trim();
}

function isCustomFieldApiName(fieldApiName) {
    return /__c$/i.test(fieldApiName);
}

/**
 * Resolve a RecordType <picklist> field to a StandardValueSet member.
 * Custom fields (__c) are never StandardValueSets. Unmapped names return null
 * — callers must not invent a member.
 *
 * @param {string|null} objectApiName
 * @param {string|null} picklistFieldName
 * @returns {string|null}
 */
function resolveRecordTypePicklistStandardValueSet(
    objectApiName,
    picklistFieldName
) {
    const fieldName = normalizeApiName(picklistFieldName);

    if (!fieldName || fieldName.includes('.') || isCustomFieldApiName(fieldName)) {
        return null;
    }

    const objectName = normalizeApiName(objectApiName);
    if (objectName) {
        const qualified = `${objectName}.${fieldName}`;
        if (Object.prototype.hasOwnProperty.call(
            OBJECT_FIELD_TO_STANDARD_VALUE_SET,
            qualified
        )) {
            return OBJECT_FIELD_TO_STANDARD_VALUE_SET[qualified];
        }
    }

    if (Object.prototype.hasOwnProperty.call(
        PICKLIST_FIELD_TO_STANDARD_VALUE_SET,
        fieldName
    )) {
        return PICKLIST_FIELD_TO_STANDARD_VALUE_SET[fieldName];
    }

    return null;
}

/**
 * Resolve a BusinessProcess object's stage/status StandardValueSet.
 * Unmapped objects (including custom objects) return null.
 *
 * @param {string|null} objectApiName
 * @returns {string|null}
 */
function resolveBusinessProcessStandardValueSet(objectApiName) {
    const objectName = normalizeApiName(objectApiName);

    if (!objectName) {
        return null;
    }

    return BUSINESS_PROCESS_OBJECT_TO_STANDARD_VALUE_SET[objectName] || null;
}

module.exports = {
    PICKLIST_FIELD_TO_STANDARD_VALUE_SET,
    OBJECT_FIELD_TO_STANDARD_VALUE_SET,
    BUSINESS_PROCESS_OBJECT_TO_STANDARD_VALUE_SET,
    resolveRecordTypePicklistStandardValueSet,
    resolveBusinessProcessStandardValueSet
};
