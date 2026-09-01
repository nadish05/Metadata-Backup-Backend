/**
 * Layout XML dependency parsing helpers.
 *
 * Converts Layout metadata constructs into deploy-relevant metadata references.
 * Configuration-only tags are intentionally ignored.
 */

const { isDeployableField } = require('./salesforceSystemFields.util');

const STANDARD_LAYOUT_BUTTONS = new Set([
    'submit',
    'edit',
    'delete',
    'clone',
    'share',
    'changeowner',
    'change record type',
    'accept',
    'decline'
]);

const STANDARD_PLATFORM_ACTIONS = new Set([
    'edit',
    'clone',
    'delete',
    'changeowner',
    'printableview',
    'submit',
    'share',
    'newcontact',
    'newopportunity',
    'newtask',
    'newevent',
    'feeditem.textpost',
    'feeditem.contentpost',
    'global.newtask',
    'global.newevent',
    'global.logacall',
    'global.newnote'
]);

const STANDARD_RELATED_LIST_DISPLAY_TOKENS = new Set([
    'name',
    'full_name',
    'firstname',
    'lastname',
    'salutation',
    'type',
    'status',
    'casesafeid'
]);

function isSafeApiName(value) {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

/**
 * Custom object API names end with __c (same rule as PermissionSet/Profile discovery).
 */
function isCustomObjectName(value) {
    const name = String(value || '').trim();

    return (
        name.endsWith('__c') &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    );
}

/**
 * Parse Object.Field__c qualified names into object and field segments.
 */
function parseQualifiedCustomFieldReference(value) {
    const normalized = String(value || '').trim();
    const separatorIndex = normalized.indexOf('.');

    if (separatorIndex <= 0) {
        return null;
    }

    const objectApiName = normalized.slice(0, separatorIndex).trim();
    const fieldApiName = normalized.slice(separatorIndex + 1).trim();

    if (
        !isSafeApiName(objectApiName) ||
        !isDeployableField(fieldApiName)
    ) {
        return null;
    }

    return {
        objectApiName,
        fieldApiName,
        qualifiedName: `${objectApiName}.${fieldApiName}`
    };
}

/**
 * Normalize related-list object tokens such as LEAD → Lead.
 */
function normalizeObjectApiNameToken(objectToken) {
    const normalized = String(objectToken || '').trim();

    if (!normalized) {
        return null;
    }

    if (/^[A-Z][A-Z0-9_]*$/.test(normalized) && !normalized.includes('__')) {
        const lower = normalized.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    }

    return normalized;
}

/**
 * Parse Object.Field related-list identifiers into CustomField member names.
 *
 * Examples:
 *   Lead.Converted_Account__c
 *   Gym_Trainer__c.Gym_Member__c
 *   Payment__c.Account__c
 */
function parseCustomRelatedListReference(relatedListValue) {
    const normalized = String(relatedListValue || '').trim();

    if (!normalized.includes('.')) {
        return null;
    }

    const separatorIndex = normalized.indexOf('.');
    const objectApiName = normalized.slice(0, separatorIndex).trim();
    const fieldApiName = normalized.slice(separatorIndex + 1).trim();

    if (!isSafeApiName(objectApiName) || !isDeployableField(fieldApiName)) {
        return null;
    }

    return `${objectApiName}.${fieldApiName}`;
}

/**
 * Parse related-list column tokens such as LEAD.COMPANY or Lead.Custom__c.
 * Standard columns are ignored.
 */
function parseRelatedListDisplayField(displayFieldValue) {
    const normalized = String(displayFieldValue || '').trim();

    if (!normalized.includes('.')) {
        if (STANDARD_RELATED_LIST_DISPLAY_TOKENS.has(normalized.toLowerCase())) {
            return null;
        }

        return null;
    }

    const separatorIndex = normalized.indexOf('.');
    const objectToken = normalized.slice(0, separatorIndex).trim();
    const fieldApiName = normalized.slice(separatorIndex + 1).trim();
    const objectApiName = normalizeObjectApiNameToken(objectToken);

    if (!objectApiName || !isDeployableField(fieldApiName)) {
        return null;
    }

    if (!isSafeApiName(objectApiName)) {
        return null;
    }

    return `${objectApiName}.${fieldApiName}`;
}

/**
 * Parse Layout custom button references into WebLink member names.
 */
function parseLayoutCustomButtonReference(buttonName, parentObjectApiName) {
    const normalized = String(buttonName || '').trim();

    if (!normalized || !parentObjectApiName) {
        return null;
    }

    if (STANDARD_LAYOUT_BUTTONS.has(normalized.toLowerCase())) {
        return null;
    }

    if (normalized.includes('.')) {
        return normalized;
    }

    return `${parentObjectApiName}.${normalized}`;
}

/**
 * Parse quickActionName / actionName values into QuickAction member names.
 */
function parseLayoutQuickActionReference(actionValue) {
    const normalized = String(actionValue || '').trim();

    if (!normalized) {
        return null;
    }

    if (STANDARD_PLATFORM_ACTIONS.has(normalized.toLowerCase())) {
        return null;
    }

    if (!normalized.includes('.') && !/__c$/i.test(normalized)) {
        return null;
    }

    return normalized;
}

/**
 * Standard relationship field tokens on Layout (e.g. ParentId) are not deployable.
 */
function isStandardRelatedObjectToken(value) {
    const normalized = String(value || '').trim().toLowerCase();

    return (
        normalized === 'parentid' ||
        normalized === 'ownerid' ||
        normalized === 'recordtypeid'
    );
}

/**
 * summaryLayout masterLabel values are internal configuration identifiers.
 */
function isInternalSummaryLayoutLabel(value) {
    const normalized = String(value || '').trim();

    return /^[a-zA-Z0-9]{15,18}$/.test(normalized);
}

function extractXmlBlocks(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
        'gi'
    );
    const blocks = [];
    let match;

    while ((match = pattern.exec(String(content || ''))) !== null) {
        blocks.push(match[1] || '');
    }

    return blocks;
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

module.exports = {
    STANDARD_LAYOUT_BUTTONS,
    STANDARD_PLATFORM_ACTIONS,
    isCustomObjectName,
    parseQualifiedCustomFieldReference,
    parseCustomRelatedListReference,
    parseRelatedListDisplayField,
    parseLayoutCustomButtonReference,
    parseLayoutQuickActionReference,
    isStandardRelatedObjectToken,
    isInternalSummaryLayoutLabel,
    extractXmlBlocks,
    extractAllXmlTagValues
};
