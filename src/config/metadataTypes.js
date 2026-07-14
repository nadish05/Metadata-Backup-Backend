const METADATA_TYPE_RULES = {
    ApexClass: {
        extension: '.cls',
        requiresMetaXml: true
    },
    ApexTrigger: {
        extension: '.trigger',
        requiresMetaXml: true
    },
    ApexPage: {
        extension: '.page',
        requiresMetaXml: true
    },
    ApexComponent: {
        extension: '.component',
        requiresMetaXml: true
    },
    CustomObject: {
        extension: '.object-meta.xml',
        requiresMetaXml: false
    },
    Flow: {
        extension: '.flow-meta.xml',
        requiresMetaXml: false
    },
    FlexiPage: {
        extension: '.flexipage-meta.xml',
        requiresMetaXml: false
    },
    PermissionSet: {
        extension: '.permissionset-meta.xml',
        requiresMetaXml: false
    },
    Profile: {
        extension: '.profile-meta.xml',
        requiresMetaXml: false
    },
    ValidationRule: {
        extension: '.validationRule-meta.xml',
        requiresMetaXml: false
    },
    RecordType: {
        extension: '.recordType-meta.xml',
        requiresMetaXml: false
    },
    CustomField: {
        extension: '.field-meta.xml',
        requiresMetaXml: false
    },
    NamedCredential: {
        extension: '.namedCredential-meta.xml',
        requiresMetaXml: false
    },
    ExternalCredential: {
        extension: '.externalCredential-meta.xml',
        requiresMetaXml: false
    },
    CustomMetadata: {
        extension: '.md-meta.xml',
        requiresMetaXml: false
    }
};

module.exports = {
    METADATA_TYPE_RULES
};
