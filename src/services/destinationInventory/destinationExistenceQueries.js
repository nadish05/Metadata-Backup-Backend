/**
 * Shared destination existence query definitions.
 *
 * Single catalog for SOQL / Tooling query construction used by
 * Destination Inventory Builder (and formerly Dependency Validation queries).
 *
 * This module builds queries only. It does not execute HTTP calls
 * and does not decide Deploy/Skip or validation status.
 */

function escapeSoql(value) {
    return String(value).replace(/'/g, "\\'");
}

function usesToolingApi(type) {
    return (
        type === 'ApexClass' ||
        type === 'ApexTrigger' ||
        type === 'CustomField' ||
        type === 'FlexiPage' ||
        type === 'LightningComponentBundle' ||
        type === 'Flow'
    );
}

function isSafeSalesforceApiName(value) {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

/**
 * Parse and normalize a CustomMetadata member name to MDAPI Type.Record.
 *
 * Accepts:
 * - Type.Record
 * - Type__mdt.Record
 *
 * Rejects bare type tokens (e.g. Type__mdt) — those are not records.
 *
 * @param {string} name
 * @returns {{
 *   canonicalMember: string,
 *   typeDeveloperName: string,
 *   recordDeveloperName: string,
 *   entityApiName: string
 * }|null}
 */
function parseCustomMetadataMember(name) {
    if (!name || typeof name !== 'string' || !name.includes('.')) {
        return null;
    }

    const separatorIndex = name.indexOf('.');
    const typePart = name.slice(0, separatorIndex).trim();
    const recordPart = name.slice(separatorIndex + 1).trim();

    if (!typePart || !recordPart || recordPart.includes('.')) {
        return null;
    }

    if (
        !isSafeSalesforceApiName(typePart) ||
        !isSafeSalesforceApiName(recordPart)
    ) {
        return null;
    }

    const typeDeveloperName = typePart.endsWith('__mdt')
        ? typePart.slice(0, -'__mdt'.length)
        : typePart;

    if (!typeDeveloperName || !isSafeSalesforceApiName(typeDeveloperName)) {
        return null;
    }

    const entityApiName = `${typeDeveloperName}__mdt`;

    if (!isSafeSalesforceApiName(entityApiName)) {
        return null;
    }

    return {
        canonicalMember: `${typeDeveloperName}.${recordPart}`,
        typeDeveloperName,
        recordDeveloperName: recordPart,
        entityApiName
    };
}

/**
 * Normalize CustomMetadata member to canonical Type.Record.
 * Returns null when the name is not a valid record member.
 *
 * @param {string} name
 * @returns {string|null}
 */
function normalizeCustomMetadataMember(name) {
    return parseCustomMetadataMember(name)?.canonicalMember || null;
}

/**
 * Build SOQL that validates a CustomMetadata RECORD (not the CMDT type).
 * Uses FROM Type__mdt WHERE DeveloperName = Record.
 *
 * @param {string} name
 * @returns {string|null}
 */
function buildCustomMetadataSoql(name) {
    const parsed = parseCustomMetadataMember(name);

    if (!parsed) {
        return null;
    }

    return (
        `SELECT Id FROM ${parsed.entityApiName} ` +
        `WHERE DeveloperName = '${escapeSoql(parsed.recordDeveloperName)}' ` +
        'LIMIT 1'
    );
}

function buildCustomFieldSoql(name) {
    if (name.includes('.')) {
        const [objectName, fieldName] = name.split('.');

        return (
            'SELECT DurableId FROM FieldDefinition ' +
            `WHERE QualifiedApiName = '${escapeSoql(fieldName)}' ` +
            `AND EntityDefinition.QualifiedApiName = '${escapeSoql(objectName)}' ` +
            'LIMIT 1'
        );
    }

    return (
        'SELECT DurableId FROM FieldDefinition ' +
        `WHERE QualifiedApiName = '${escapeSoql(name)}' ` +
        'LIMIT 1'
    );
}

function buildListViewSoql(name) {
    if (!name.includes('.')) {
        return null;
    }

    const [objectApiName, developerName] = name.split('.');

    if (!objectApiName || !developerName) {
        return null;
    }

    return (
        'SELECT Id, DeveloperName, SobjectType FROM ListView ' +
        `WHERE DeveloperName = '${escapeSoql(developerName)}' ` +
        `AND SobjectType = '${escapeSoql(objectApiName)}' ` +
        'LIMIT 1'
    );
}

function buildRecordTypeSoql(name) {
    if (!name.includes('.')) {
        return null;
    }

    const [objectApiName, developerName] = name.split('.');

    if (!objectApiName || !developerName) {
        return null;
    }

    return (
        'SELECT Id, DeveloperName, SobjectType FROM RecordType ' +
        `WHERE DeveloperName = '${escapeSoql(developerName)}' ` +
        `AND SobjectType = '${escapeSoql(objectApiName)}' ` +
        'LIMIT 1'
    );
}

function buildExistenceQuery(type, name) {
    const escapedName = escapeSoql(name);

    switch (type) {
        case 'ApexClass':
            return `SELECT Id FROM ApexClass WHERE Name = '${escapedName}' LIMIT 1`;

        case 'ApexTrigger':
            return `SELECT Id FROM ApexTrigger WHERE Name = '${escapedName}' LIMIT 1`;

        case 'CustomObject':
            return (
                'SELECT QualifiedApiName FROM EntityDefinition ' +
                `WHERE QualifiedApiName = '${escapedName}' LIMIT 1`
            );

        case 'CustomField':
            return buildCustomFieldSoql(name);

        case 'CustomTab':
            return (
                'SELECT DurableId, Name FROM TabDefinition ' +
                `WHERE Name = '${escapedName}' LIMIT 1`
            );

        case 'ListView':
            return buildListViewSoql(name);

        case 'RecordType':
            return buildRecordTypeSoql(name);

        case 'FlexiPage':
            return (
                'SELECT Id, DeveloperName FROM FlexiPage ' +
                `WHERE DeveloperName = '${escapedName}' LIMIT 1`
            );

        case 'LightningComponentBundle':
            return (
                'SELECT Id, DeveloperName FROM LightningComponentBundle ' +
                `WHERE DeveloperName = '${escapedName}' LIMIT 1`
            );

        case 'NamedCredential':
            return (
                'SELECT Id FROM NamedCredential ' +
                `WHERE DeveloperName = '${escapedName}' LIMIT 1`
            );

        case 'CustomMetadata':
            // Record existence (Type.Record), not EntityDefinition type lookup.
            return buildCustomMetadataSoql(name);

        case 'CustomLabel':
            return (
                'SELECT Id FROM ExternalString ' +
                `WHERE Name = '${escapedName}' LIMIT 1`
            );

        case 'PermissionSet':
            return (
                'SELECT Id, Name FROM PermissionSet ' +
                `WHERE Name = '${escapedName}' ` +
                'AND IsOwnedByProfile = false LIMIT 1'
            );

        case 'Flow':
            // Tooling FlowDefinition.DeveloperName = Flow API name.
            return (
                'SELECT Id FROM FlowDefinition ' +
                `WHERE DeveloperName = '${escapedName}' LIMIT 1`
            );

        // EmailAlert / WorkflowAlert: no reliable SOQL existence query in this
        // catalog — callers receive UNKNOWN via unsupported query path.
        case 'EmailAlert':
            return null;

        default:
            return null;
    }
}

module.exports = {
    escapeSoql,
    usesToolingApi,
    isSafeSalesforceApiName,
    parseCustomMetadataMember,
    normalizeCustomMetadataMember,
    buildCustomMetadataSoql,
    buildCustomFieldSoql,
    buildListViewSoql,
    buildRecordTypeSoql,
    buildExistenceQuery
};
