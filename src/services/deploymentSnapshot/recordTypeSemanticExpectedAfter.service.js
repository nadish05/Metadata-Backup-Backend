'use strict';

const { unpackMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');

const RECORDTYPE_SEMANTIC_VERSION = 'RECORDTYPE_SEMANTIC_V1';

function parseRecordTypeIdentity(metadataName) {
    const value = String(metadataName || '').trim();
    const separator = value.indexOf('.');

    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(
            'RecordType semantic metadataName must be Object.DeveloperName.'
        );
    }

    return {
        objectApiName: value.slice(0, separator).trim(),
        developerName: value.slice(separator + 1).trim()
    };
}

function extractXmlTagValue(content, tagName) {
    const pattern = new RegExp(
        `<${tagName}>\\s*([^<]*?)\\s*</${tagName}>`,
        'i'
    );
    const match = String(content || '').match(pattern);

    return match ? match[1].trim() : null;
}

function parseBooleanTag(content, tagName) {
    const raw = extractXmlTagValue(content, tagName);

    if (raw === null) {
        return null;
    }

    if (raw.toLowerCase() === 'true') {
        return true;
    }

    if (raw.toLowerCase() === 'false') {
        return false;
    }

    throw new Error(`RecordType semantic invalid boolean for <${tagName}>.`);
}

function parsePicklistValueBlocks(xml) {
    const picklists = [];
    const blockPattern = /<picklistValues>([\s\S]*?)<\/picklistValues>/gi;
    let blockMatch;

    while ((blockMatch = blockPattern.exec(String(xml || ''))) !== null) {
        const block = blockMatch[1];
        const fieldApiName = extractXmlTagValue(block, 'picklist');

        if (!fieldApiName) {
            throw new Error('RecordType semantic picklist block missing <picklist>.');
        }

        const values = [];
        const valuePattern = /<values>([\s\S]*?)<\/values>/gi;
        let valueMatch;
        const seenValues = new Set();

        while ((valueMatch = valuePattern.exec(block)) !== null) {
            const valueBlock = valueMatch[1];
            const value = extractXmlTagValue(valueBlock, 'fullName');

            if (!value) {
                throw new Error(
                    `RecordType semantic picklist ${fieldApiName} value missing <fullName>.`
                );
            }

            if (seenValues.has(value)) {
                throw new Error(
                    `RecordType semantic duplicate picklist value ${fieldApiName}:${value}.`
                );
            }

            seenValues.add(value);
            const defaultRaw = extractXmlTagValue(valueBlock, 'default');
            let defaultFlag = false;

            if (defaultRaw !== null) {
                if (defaultRaw.toLowerCase() === 'true') {
                    defaultFlag = true;
                } else if (defaultRaw.toLowerCase() !== 'false') {
                    throw new Error(
                        `RecordType semantic invalid default for ${fieldApiName}:${value}.`
                    );
                }
            }

            values.push({
                value,
                label: value,
                default: defaultFlag,
                validFor: []
            });
        }

        picklists.push({
            fieldApiName,
            defaultValue: null,
            controllerValues: {},
            values
        });
    }

    return picklists;
}

function buildSemanticModelFromRecordTypeXml(xml, metadataName) {
    const identity = parseRecordTypeIdentity(metadataName);
    const fullName = extractXmlTagValue(xml, 'fullName');
    const label = extractXmlTagValue(xml, 'label');
    const active = parseBooleanTag(xml, 'active');
    const businessProcess = extractXmlTagValue(xml, 'businessProcess');
    const compactLayoutAssignment = extractXmlTagValue(
        xml,
        'compactLayoutAssignment'
    );

    if (fullName && fullName !== identity.developerName) {
        throw new Error(
            'RecordType semantic fullName does not match metadataName developerName.'
        );
    }

    if (label === null) {
        throw new Error('RecordType semantic missing <label>.');
    }

    if (active === null) {
        throw new Error('RecordType semantic missing <active>.');
    }

    const picklists = parsePicklistValueBlocks(xml);

    return {
        semanticVersion: RECORDTYPE_SEMANTIC_VERSION,
        metadataType: 'RecordType',
        objectApiName: identity.objectApiName,
        developerName: identity.developerName,
        label,
        active,
        businessProcess: businessProcess || null,
        compactLayoutAssignment: compactLayoutAssignment || null,
        picklists
    };
}

function sortControllerValues(controllerValues) {
    const source = controllerValues && typeof controllerValues === 'object'
        ? controllerValues
        : {};
    const sorted = {};

    for (const key of Object.keys(source).sort()) {
        sorted[key] = source[key];
    }

    return sorted;
}

function normalizePicklistForCanonical(picklist) {
    const values = [...(picklist.values || [])]
        .map((entry) => ({
            value: String(entry.value),
            label: String(entry.label != null ? entry.label : entry.value),
            default: entry.default === true,
            validFor: [...(entry.validFor || [])].sort((a, b) => a - b)
        }))
        .sort((left, right) => left.value.localeCompare(right.value, 'en'));

    const seen = new Set();

    for (const entry of values) {
        if (seen.has(entry.value)) {
            throw new Error(
                `RecordType semantic duplicate picklist value ${picklist.fieldApiName}:${entry.value}.`
            );
        }

        seen.add(entry.value);
    }

    let defaultValue = picklist.defaultValue;

    if (defaultValue === undefined || defaultValue === '') {
        defaultValue = null;
    }

    return {
        fieldApiName: String(picklist.fieldApiName),
        defaultValue,
        controllerValues: sortControllerValues(picklist.controllerValues),
        values
    };
}

function canonicalizeRecordTypeSemanticModel(model) {
    const picklists = [...(model.picklists || [])]
        .map(normalizePicklistForCanonical)
        .sort((left, right) =>
            left.fieldApiName.localeCompare(right.fieldApiName, 'en')
        );

    const canonical = {
        semanticVersion: model.semanticVersion,
        metadataType: model.metadataType,
        objectApiName: model.objectApiName,
        developerName: model.developerName,
        label: model.label,
        active: model.active === true,
        businessProcess: model.businessProcess || null,
        compactLayoutAssignment: model.compactLayoutAssignment || null,
        picklists
    };

    return JSON.stringify(canonical);
}

function hashRecordTypeSemanticModel(model) {
    const canonicalJson = canonicalizeRecordTypeSemanticModel(model);

    return {
        canonicalJson,
        canonicalHash: hashBytes(Buffer.from(canonicalJson, 'utf8'))
    };
}

function buildRecordTypeSemanticCaptureSpec(model) {
    const picklistFieldApiNames = [...(model.picklists || [])]
        .map((entry) => String(entry.fieldApiName))
        .sort((left, right) => left.localeCompare(right, 'en'));

    return {
        semanticVersion: RECORDTYPE_SEMANTIC_VERSION,
        metadataType: 'RecordType',
        objectApiName: model.objectApiName,
        developerName: model.developerName,
        picklistFieldApiNames
    };
}

function findRecordTypeXmlString(artifactBytes) {
    const files = unpackMemberFiles(artifactBytes);
    const recordTypeFile = files.find((file) =>
        String(file.relativePath || '').endsWith('.recordType-meta.xml')
    );

    if (!recordTypeFile) {
        throw new Error('RecordType semantic workspace artifact missing RecordType XML.');
    }

    return recordTypeFile.bytes.toString('utf8');
}

function buildRecordTypeSemanticFromWorkspaceArtifact(artifactBytes, metadataName) {
    const xml = findRecordTypeXmlString(artifactBytes);
    const model = buildSemanticModelFromRecordTypeXml(xml, metadataName);
    const { canonicalJson, canonicalHash } = hashRecordTypeSemanticModel(model);
    const captureSpec = buildRecordTypeSemanticCaptureSpec(model);

    return {
        model,
        captureSpec,
        canonicalJson,
        canonicalHash
    };
}

module.exports = {
    RECORDTYPE_SEMANTIC_VERSION,
    parseRecordTypeIdentity,
    buildSemanticModelFromRecordTypeXml,
    canonicalizeRecordTypeSemanticModel,
    hashRecordTypeSemanticModel,
    buildRecordTypeSemanticCaptureSpec,
    buildRecordTypeSemanticFromWorkspaceArtifact,
    normalizePicklistForCanonical
};
