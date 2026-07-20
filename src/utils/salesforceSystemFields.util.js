/**
 * Single source of truth for Salesforce-managed system fields.
 * These fields must never become deployable metadata, graph blockers,
 * or deployment recommendations.
 */

const SALESFORCE_SYSTEM_FIELDS = new Set([
    'id',
    'name',
    'ownerid',
    'createdbyid',
    'createddate',
    'lastmodifiedbyid',
    'lastmodifieddate',
    'systemmodstamp',
    'lastvieweddate',
    'lastreferenceddate',
    'isdeleted',
    'masterrecordid',
    'currencyisocode',
    'recordtypeid'
]);

/**
 * Extract the bare field API name from a qualified or unqualified value.
 * Examples:
 *   OwnerId → OwnerId
 *   Account.OwnerId → OwnerId
 *   My_Object__c.CreatedById → CreatedById
 */
function extractFieldApiName(fieldName) {
    const normalized = String(fieldName || '').trim();

    if (!normalized) {
        return '';
    }

    const parts = normalized.split('.');
    return parts[parts.length - 1] || '';
}

/**
 * True when the field is a Salesforce-managed system field.
 * Accepts bare or Object.Field qualified names.
 */
function isSalesforceSystemField(fieldName) {
    const fieldApiName = extractFieldApiName(fieldName);

    if (!fieldApiName) {
        return false;
    }

    return SALESFORCE_SYSTEM_FIELDS.has(fieldApiName.toLowerCase());
}

/**
 * True when the field is a deployable CustomField dependency.
 * Custom fields (__c) and namespaced custom fields (ns__Field__c) qualify.
 * System fields and other standard fields do not.
 */
function isDeployableField(fieldName) {
    const fieldApiName = extractFieldApiName(fieldName);

    if (!fieldApiName) {
        return false;
    }

    if (isSalesforceSystemField(fieldApiName)) {
        return false;
    }

    return /__c$/i.test(fieldApiName);
}

module.exports = {
    SALESFORCE_SYSTEM_FIELDS,
    extractFieldApiName,
    isSalesforceSystemField,
    isDeployableField
};
