/**
 * Metadata type rules for validation, workspace resolution, and packaging.
 *
 * kind:
 *   FILE      – single primary file (+ optional companion -meta.xml)
 *   BUNDLE    – directory of related assets (LWC, Aura, …)
 *   DIRECTORY – reserved for future folder-based types
 */

const METADATA_KINDS = Object.freeze({
    FILE: 'FILE',
    BUNDLE: 'BUNDLE',
    DIRECTORY: 'DIRECTORY'
});

const METADATA_TYPE_RULES = {
    ApexClass: {
        kind: METADATA_KINDS.FILE,
        extension: '.cls',
        requiresMetaXml: true
    },
    ApexTrigger: {
        kind: METADATA_KINDS.FILE,
        extension: '.trigger',
        requiresMetaXml: true
    },
    ApexPage: {
        kind: METADATA_KINDS.FILE,
        extension: '.page',
        requiresMetaXml: true
    },
    ApexComponent: {
        kind: METADATA_KINDS.FILE,
        extension: '.component',
        requiresMetaXml: true
    },
    CustomObject: {
        kind: METADATA_KINDS.FILE,
        extension: '.object-meta.xml',
        requiresMetaXml: false
    },
    CustomTab: {
        kind: METADATA_KINDS.FILE,
        folder: 'tabs',
        extension: '.tab-meta.xml',
        memberNamePattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
        requiresMetaXml: false
    },
    CustomApplication: {
        kind: METADATA_KINDS.FILE,
        folder: 'applications',
        extension: '.app-meta.xml',
        memberNamePattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
        requiresMetaXml: false
    },
    Flow: {
        kind: METADATA_KINDS.FILE,
        extension: '.flow-meta.xml',
        requiresMetaXml: false
    },
    FlexiPage: {
        kind: METADATA_KINDS.FILE,
        extension: '.flexipage-meta.xml',
        requiresMetaXml: false
    },
    PermissionSet: {
        kind: METADATA_KINDS.FILE,
        extension: '.permissionset-meta.xml',
        requiresMetaXml: false
    },
    Profile: {
        kind: METADATA_KINDS.FILE,
        extension: '.profile-meta.xml',
        requiresMetaXml: false
    },
    ValidationRule: {
        kind: METADATA_KINDS.FILE,
        extension: '.validationRule-meta.xml',
        requiresMetaXml: false
    },
    RecordType: {
        kind: METADATA_KINDS.FILE,
        extension: '.recordType-meta.xml',
        requiresMetaXml: false
    },
    CustomField: {
        kind: METADATA_KINDS.FILE,
        extension: '.field-meta.xml',
        requiresMetaXml: false
    },
    CompactLayout: {
        kind: METADATA_KINDS.FILE,
        extension: '.compactLayout-meta.xml',
        requiresMetaXml: false
    },
    FieldSet: {
        kind: METADATA_KINDS.FILE,
        extension: '.fieldSet-meta.xml',
        requiresMetaXml: false
    },
    ListView: {
        kind: METADATA_KINDS.FILE,
        extension: '.listView-meta.xml',
        requiresMetaXml: false
    },
    SharingReason: {
        kind: METADATA_KINDS.FILE,
        extension: '.sharingReason-meta.xml',
        requiresMetaXml: false
    },
    WebLink: {
        kind: METADATA_KINDS.FILE,
        extension: '.webLink-meta.xml',
        requiresMetaXml: false
    },
    Index: {
        kind: METADATA_KINDS.FILE,
        extension: '.index-meta.xml',
        requiresMetaXml: false
    },
    NamedCredential: {
        kind: METADATA_KINDS.FILE,
        extension: '.namedCredential-meta.xml',
        requiresMetaXml: false
    },
    ExternalCredential: {
        kind: METADATA_KINDS.FILE,
        extension: '.externalCredential-meta.xml',
        requiresMetaXml: false
    },
    CustomMetadata: {
        kind: METADATA_KINDS.FILE,
        extension: '.md-meta.xml',
        requiresMetaXml: false
    },
    CustomLabel: {
        kind: METADATA_KINDS.FILE,
        extension: '.labels-meta.xml',
        requiresMetaXml: false
    },
    LightningComponentBundle: {
        kind: METADATA_KINDS.BUNDLE,
        folder: 'lwc',
        descriptorExtension: '.js-meta.xml',
        requiresMetaXml: false
    }
};

function getMetadataKind(metadataType) {
    const rule = METADATA_TYPE_RULES[metadataType];

    if (!rule) {
        return null;
    }

    return rule.kind || METADATA_KINDS.FILE;
}

function isBundleMetadataType(metadataType) {
    return getMetadataKind(metadataType) === METADATA_KINDS.BUNDLE;
}

function getMetadataTypeRule(metadataType) {
    return METADATA_TYPE_RULES[metadataType] || null;
}

module.exports = {
    METADATA_KINDS,
    METADATA_TYPE_RULES,
    getMetadataKind,
    isBundleMetadataType,
    getMetadataTypeRule
};
