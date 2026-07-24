/**
 * Source CustomField XML → structural attributes (Phase 9C).
 * Pure parser — no I/O. Attributes align with Destination Shape model.
 */

const {
    parseCustomFieldName
} = require('../../destinationShape/destinationShape.model');

/** MDAPI <type> → Salesforce describe SOAP type (deterministic). */
const MDAPI_TYPE_TO_SOAP = Object.freeze({
    Text: 'string',
    LongTextArea: 'textarea',
    Html: 'textarea',
    TextArea: 'textarea',
    EncryptedText: 'encryptedstring',
    Number: 'double',
    Currency: 'currency',
    Percent: 'percent',
    Checkbox: 'boolean',
    Date: 'date',
    DateTime: 'datetime',
    Time: 'time',
    Phone: 'phone',
    Email: 'email',
    Url: 'url',
    Picklist: 'picklist',
    MultiselectPicklist: 'multipicklist',
    Lookup: 'reference',
    MasterDetail: 'reference',
    ExternalLookup: 'reference',
    IndirectLookup: 'reference',
    AutoNumber: 'string',
    Location: 'location',
    Address: 'address',
    File: 'base64',
    MetadataRelationship: 'reference'
});

function extractXmlTagValue(xml, tagName) {
    if (!xml || !tagName) {
        return null;
    }

    const pattern = new RegExp(
        `<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(xml).match(pattern);

    if (!match) {
        return null;
    }

    return match[1].trim();
}

function extractXmlTagBoolean(xml, tagName) {
    const value = extractXmlTagValue(xml, tagName);

    if (value == null) {
        return null;
    }

    const normalized = value.toLowerCase();

    if (normalized === 'true') {
        return true;
    }

    if (normalized === 'false') {
        return false;
    }

    return null;
}

function extractXmlTagNumber(xml, tagName) {
    const value = extractXmlTagValue(xml, tagName);

    if (value == null || value === '') {
        return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
}

function extractPicklistValuesFromXml(xml) {
    const valueSetXml = extractXmlTagValue(xml, 'valueSet');

    if (!valueSetXml) {
        return null;
    }

    const values = [];
    const valueBlockPattern =
        /<value>([\s\S]*?)<\/value>/gi;
    let match;

    while ((match = valueBlockPattern.exec(valueSetXml)) !== null) {
        const block = match[1];
        const fullName = extractXmlTagValue(block, 'fullName');

        if (!fullName) {
            continue;
        }

        const isActive = extractXmlTagBoolean(block, 'isActive');

        values.push({
            value: fullName,
            label: extractXmlTagValue(block, 'label') || fullName,
            active: isActive !== false,
            defaultValue: extractXmlTagBoolean(block, 'default') === true
        });
    }

    return values.length ? values : null;
}

function normalizeMdapiTypeToSoap(mdapiType) {
    if (!mdapiType) {
        return null;
    }

    return MDAPI_TYPE_TO_SOAP[mdapiType] || null;
}

/**
 * Parse CustomField metadata XML into destination-shape-compatible attributes.
 *
 * @param {string} fieldXml
 * @param {string} [metadataName] Object.Field
 * @returns {{
 *   metadataType: string,
 *   metadataName: string|null,
 *   parentObject: string|null,
 *   apiName: string|null,
 *   attributes: object|null,
 *   warning: string|null
 * }}
 */
function parseSourceCustomFieldXml(fieldXml, metadataName = null) {
    const parsedName = parseCustomFieldName(metadataName);
    const fullName = extractXmlTagValue(fieldXml, 'fullName');
    const mdapiType = extractXmlTagValue(fieldXml, 'type');
    const soapType = normalizeMdapiTypeToSoap(mdapiType);

    if (!fieldXml || !mdapiType) {
        return {
            metadataType: 'CustomField',
            metadataName: parsedName?.canonicalName || metadataName || null,
            parentObject: parsedName?.parentObject || null,
            apiName: parsedName?.fieldApiName || fullName || null,
            attributes: null,
            warning: 'Source CustomField XML missing type.'
        };
    }

    if (!soapType) {
        return {
            metadataType: 'CustomField',
            metadataName: parsedName?.canonicalName || metadataName || null,
            parentObject: parsedName?.parentObject || null,
            apiName: parsedName?.fieldApiName || fullName || null,
            attributes: null,
            warning: `Source CustomField type "${mdapiType}" is not mapped for CONTRACT.`
        };
    }

    const referenceToRaw = extractXmlTagValue(fieldXml, 'referenceTo');
    const referenceTo = referenceToRaw ? [referenceToRaw] : [];

    const attributes = {
        type: soapType,
        mdapiType,
        length: extractXmlTagNumber(fieldXml, 'length'),
        precision: extractXmlTagNumber(fieldXml, 'precision'),
        scale: extractXmlTagNumber(fieldXml, 'scale'),
        required: extractXmlTagBoolean(fieldXml, 'required'),
        unique: extractXmlTagBoolean(fieldXml, 'unique'),
        externalId: extractXmlTagBoolean(fieldXml, 'externalId'),
        referenceTo,
        picklistValues: extractPicklistValuesFromXml(fieldXml),
        label: extractXmlTagValue(fieldXml, 'label'),
        calculated: Boolean(extractXmlTagValue(fieldXml, 'formula')),
        custom: true
    };

    return {
        metadataType: 'CustomField',
        metadataName: parsedName?.canonicalName || metadataName || null,
        parentObject: parsedName?.parentObject || null,
        apiName: parsedName?.fieldApiName || fullName || null,
        attributes,
        warning: null
    };
}

module.exports = {
    MDAPI_TYPE_TO_SOAP,
    normalizeMdapiTypeToSoap,
    parseSourceCustomFieldXml,
    extractXmlTagValue
};
