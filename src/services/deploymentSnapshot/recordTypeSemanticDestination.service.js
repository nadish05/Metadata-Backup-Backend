'use strict';

const axios = require('axios');

const { DEFAULT_API_VERSION } = require('../../config/salesforce');
const { buildRecordTypeSoql } = require('../destinationInventory/destinationExistenceQueries');
const {
    parseRecordTypeIdentity,
    buildSemanticModelFromRecordTypeXml,
    hashRecordTypeSemanticModel,
    RECORDTYPE_SEMANTIC_VERSION
} = require('./recordTypeSemanticExpectedAfter.service');
const { unpackMemberFiles } = require('./destinationMemberArtifact.service');

function findRecordTypeXmlFromArtifact(artifactBytes) {
    const files = unpackMemberFiles(artifactBytes);
    const recordTypeFile = files.find((file) =>
        String(file.relativePath || '').endsWith('.recordType-meta.xml')
    );

    if (!recordTypeFile) {
        throw new Error(
            'RecordType semantic destination artifact missing RecordType XML.'
        );
    }

    return recordTypeFile.bytes.toString('utf8');
}

function assertCaptureSpecMatchesMetadata(captureSpec, metadataName) {
    const identity = parseRecordTypeIdentity(metadataName);

    if (!captureSpec || captureSpec.semanticVersion !== RECORDTYPE_SEMANTIC_VERSION) {
        throw new Error('RecordType semantic capture spec version mismatch.');
    }

    if (captureSpec.metadataType !== 'RecordType') {
        throw new Error('RecordType semantic capture spec metadataType mismatch.');
    }

    if (
        captureSpec.objectApiName !== identity.objectApiName ||
        captureSpec.developerName !== identity.developerName
    ) {
        throw new Error('RecordType semantic capture spec identity mismatch.');
    }

    if (
        !Array.isArray(captureSpec.picklistFieldApiNames) ||
        !captureSpec.picklistFieldApiNames.length
    ) {
        throw new Error('RecordType semantic capture spec picklistFieldApiNames missing.');
    }
}

async function queryRecordTypeRow({
    instanceUrl,
    accessToken,
    apiVersion,
    metadataName
}) {
    const baseSoql = buildRecordTypeSoql(metadataName);

    if (!baseSoql) {
        throw new Error('RecordType semantic SOQL could not be built.');
    }

    const soql =
        baseSoql.replace(
            'SELECT Id, DeveloperName, SobjectType',
            'SELECT Id, DeveloperName, SobjectType, Name, IsActive'
        );

    const endpoint = `${String(instanceUrl).replace(/\/$/, '')}/services/data/v${apiVersion}/query?q=${encodeURIComponent(soql)}`;
    const response = await axios.get(endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000
    });

    const records = response.data?.records;

    if (!Array.isArray(records) || records.length !== 1) {
        throw new Error('RecordType semantic query did not resolve exactly one RecordType.');
    }

    return records[0];
}

async function fetchRecordTypePicklistFieldValues({
    instanceUrl,
    accessToken,
    apiVersion,
    objectApiName,
    recordTypeId
}) {
    const base = String(instanceUrl).replace(/\/$/, '');
    const url = `${base}/services/data/v${apiVersion}/ui-api/object-info/${encodeURIComponent(objectApiName)}/picklist-values/${encodeURIComponent(recordTypeId)}`;
    const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 60000
    });

    const picklistFieldValues = response.data?.picklistFieldValues;

    if (!picklistFieldValues || typeof picklistFieldValues !== 'object') {
        throw new Error('RecordType semantic UI API response missing picklistFieldValues.');
    }

    return picklistFieldValues;
}

function mapUiPicklistToSemantic(fieldApiName, uiField) {
    if (!uiField || !Array.isArray(uiField.values)) {
        throw new Error(
            `RecordType semantic UI API picklist ${fieldApiName} missing values.`
        );
    }

    const values = uiField.values.map((entry) => ({
        value: String(entry.value),
        label: String(entry.label != null ? entry.label : entry.value),
        default: false,
        validFor: [...(entry.validFor || [])].sort((a, b) => a - b)
    }));

    let defaultValue = uiField.defaultValue;

    if (defaultValue === undefined || defaultValue === '') {
        defaultValue = null;
    }

    return {
        fieldApiName,
        defaultValue,
        controllerValues:
            uiField.controllerValues && typeof uiField.controllerValues === 'object'
                ? uiField.controllerValues
                : {},
        values
    };
}

function buildPicklistsFromUiApi(picklistFieldValues, picklistFieldApiNames) {
    const picklists = [];

    for (const fieldApiName of picklistFieldApiNames) {
        if (!Object.prototype.hasOwnProperty.call(picklistFieldValues, fieldApiName)) {
            throw new Error(
                `RecordType semantic expected picklist ${fieldApiName} missing from UI API.`
            );
        }

        picklists.push(
            mapUiPicklistToSemantic(fieldApiName, picklistFieldValues[fieldApiName])
        );
    }

    return picklists;
}

function buildDestinationScalarsFromXml(xml, recordTypeRow) {
    let modelFromXml;

    try {
        modelFromXml = buildSemanticModelFromRecordTypeXml(
            xml,
            `${recordTypeRow.SobjectType}.${recordTypeRow.DeveloperName}`
        );
    } catch (error) {
        throw new Error('RecordType semantic destination XML scalar parse failed.');
    }

    if (recordTypeRow.Name != null && String(recordTypeRow.Name) !== modelFromXml.label) {
        throw new Error('RecordType semantic destination label mismatch.');
    }

    if (
        typeof recordTypeRow.IsActive === 'boolean' &&
        recordTypeRow.IsActive !== modelFromXml.active
    ) {
        throw new Error('RecordType semantic destination active mismatch.');
    }

    return {
        label: modelFromXml.label,
        active: modelFromXml.active,
        businessProcess: modelFromXml.businessProcess,
        compactLayoutAssignment: modelFromXml.compactLayoutAssignment
    };
}

async function buildRecordTypeSemanticFromDestination({
    accessToken,
    instanceUrl,
    metadataName,
    recordTypeSemanticCaptureSpec,
    destinationArtifactBytes,
    apiVersion = DEFAULT_API_VERSION
} = {}) {
    if (!accessToken || !instanceUrl) {
        throw new Error('RecordType semantic destination missing credentials.');
    }

    if (!destinationArtifactBytes || !destinationArtifactBytes.length) {
        throw new Error('RecordType semantic destination missing artifact bytes.');
    }

    assertCaptureSpecMatchesMetadata(recordTypeSemanticCaptureSpec, metadataName);

    const identity = parseRecordTypeIdentity(metadataName);
    const recordTypeRow = await queryRecordTypeRow({
        instanceUrl,
        accessToken,
        apiVersion,
        metadataName
    });

    const picklistFieldValues = await fetchRecordTypePicklistFieldValues({
        instanceUrl,
        accessToken,
        apiVersion,
        objectApiName: identity.objectApiName,
        recordTypeId: recordTypeRow.Id
    });

    const sortedFieldNames = [...recordTypeSemanticCaptureSpec.picklistFieldApiNames].sort(
        (left, right) => left.localeCompare(right, 'en')
    );

    const xml = findRecordTypeXmlFromArtifact(destinationArtifactBytes);
    const scalars = buildDestinationScalarsFromXml(xml, recordTypeRow);

    const model = {
        semanticVersion: RECORDTYPE_SEMANTIC_VERSION,
        metadataType: 'RecordType',
        objectApiName: identity.objectApiName,
        developerName: identity.developerName,
        label: scalars.label,
        active: scalars.active,
        businessProcess: scalars.businessProcess,
        compactLayoutAssignment: scalars.compactLayoutAssignment,
        picklists: buildPicklistsFromUiApi(picklistFieldValues, sortedFieldNames)
    };

    const { canonicalJson, canonicalHash } = hashRecordTypeSemanticModel(model);

    return {
        model,
        canonicalJson,
        canonicalHash
    };
}

module.exports = {
    buildRecordTypeSemanticFromDestination,
    fetchRecordTypePicklistFieldValues,
    queryRecordTypeRow,
    buildPicklistsFromUiApi
};
