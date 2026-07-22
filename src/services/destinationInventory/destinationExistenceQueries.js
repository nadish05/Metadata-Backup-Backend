/**
 * Shared destination existence query definitions.
 *
 * Single catalog for SOQL / Tooling query construction used by
 * Dependency Validation (and later Destination Inventory Builder).
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
        type === 'LightningComponentBundle'
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
            return (
                'SELECT QualifiedApiName FROM EntityDefinition ' +
                `WHERE QualifiedApiName = '${escapedName}' LIMIT 1`
            );

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

        default:
            return null;
    }
}

module.exports = {
    escapeSoql,
    usesToolingApi,
    buildCustomFieldSoql,
    buildListViewSoql,
    buildRecordTypeSoql,
    buildExistenceQuery
};
