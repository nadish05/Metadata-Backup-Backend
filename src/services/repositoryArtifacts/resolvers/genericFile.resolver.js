/**
 * Fallback artifact resolver for FILE metadata types registered in METADATA_TYPE_RULES.
 * Used when no type-specific resolver claims the metadata type.
 */

const {
    METADATA_TYPE_RULES,
    METADATA_KINDS,
    getMetadataKind
} = require('../../../config/metadataTypes');

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function basenameWithoutSuffix(filePath, suffix) {
    const normalized = normalizePath(filePath);
    const base = normalized.split('/').pop() || '';

    if (!base.endsWith(suffix)) {
        return null;
    }

    return base.slice(0, -suffix.length);
}

const SPECIFIC_TYPES = new Set([
    'CustomObject',
    'CustomField',
    'FlexiPage',
    'LightningComponentBundle',
    'ApexClass',
    'ListView'
]);

const genericFileArtifactResolver = {
    id: 'GenericFileArtifactResolver',
    metadataTypes: [],

    applies(metadataType) {
        if (!metadataType || SPECIFIC_TYPES.has(metadataType)) {
            return false;
        }

        const rule = METADATA_TYPE_RULES[metadataType];

        return Boolean(
            rule &&
                getMetadataKind(metadataType) === METADATA_KINDS.FILE &&
                rule.extension
        );
    },

    resolve({ name, metadataType, repoFiles }) {
        const rule = METADATA_TYPE_RULES[metadataType];

        if (!rule?.extension || !name || !Array.isArray(repoFiles)) {
            return null;
        }

        const suffix = rule.extension;

        // Object-child style names: Object.Child
        if (name.includes('.')) {
            const [objectApiName, childApiName] = name.split('.');
            const folderHints = {
                ValidationRule: 'validationRules',
                RecordType: 'recordTypes',
                CompactLayout: 'compactLayouts',
                FieldSet: 'fieldSets',
                SharingReason: 'sharingReasons',
                WebLink: 'webLinks',
                Index: 'indexes'
            };
            const folder = folderHints[metadataType];

            if (folder && objectApiName && childApiName) {
                const expectedFolder = `/objects/${objectApiName}/${folder}/`;

                return (
                    repoFiles
                        .map(normalizePath)
                        .find(
                            (repoFile) =>
                                repoFile.endsWith(suffix) &&
                                repoFile.includes(expectedFolder) &&
                                basenameWithoutSuffix(repoFile, suffix) ===
                                    childApiName
                        ) || null
                );
            }
        }

        if (metadataType === 'CustomLabel') {
            return (
                repoFiles
                    .map(normalizePath)
                    .find((repoFile) =>
                        repoFile.endsWith('CustomLabels.labels-meta.xml')
                    ) || null
            );
        }

        if (metadataType === 'CustomMetadata') {
            const recordName = name.includes('.')
                ? name.split('.').pop()
                : name;

            return (
                repoFiles
                    .map(normalizePath)
                    .find(
                        (repoFile) =>
                            repoFile.endsWith(suffix) &&
                            basenameWithoutSuffix(repoFile, suffix) ===
                                recordName
                    ) || null
            );
        }

        return (
            repoFiles
                .map(normalizePath)
                .find(
                    (repoFile) =>
                        repoFile.endsWith(suffix) &&
                        basenameWithoutSuffix(repoFile, suffix) === name
                ) || null
        );
    }
};

module.exports = genericFileArtifactResolver;
