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

        if (
            rule.memberNamePattern instanceof RegExp &&
            !rule.memberNamePattern.test(name)
        ) {
            return null;
        }

        const suffix = rule.extension;

        // Object-child style names: Object.Child
        if (name.includes('.')) {
            const [objectApiName, childApiName] = name.split('.');
            const folderHints = {
                ValidationRule: 'validationRules',
                RecordType: 'recordTypes',
                BusinessProcess: 'businessProcesses',
                CompactLayout: 'compactLayouts',
                FieldSet: 'fieldSets',
                SharingReason: 'sharingReasons',
                WebLink: 'webLinks',
                Index: 'indexes'
            };
            const folder = folderHints[metadataType];

            // BusinessProcess names preserve spaces and must split on first '.'.
            const objectChild =
                metadataType === 'BusinessProcess' && name.includes('.')
                    ? {
                          objectApiName: name.slice(0, name.indexOf('.')).trim(),
                          childApiName: name.slice(name.indexOf('.') + 1).trim()
                      }
                    : { objectApiName, childApiName };

            if (folder && objectChild.objectApiName && objectChild.childApiName) {
                const expectedFolder = `/objects/${objectChild.objectApiName}/${folder}/`;

                return (
                    repoFiles
                        .map(normalizePath)
                        .find(
                            (repoFile) =>
                                repoFile.endsWith(suffix) &&
                                repoFile.includes(expectedFolder) &&
                                basenameWithoutSuffix(repoFile, suffix) ===
                                    objectChild.childApiName
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

        // CustomMetadata DX files are Type.Record.md-meta.xml — match the full
        // member basename (Weather_Config.Default), not the trailing segment.
        if (metadataType === 'CustomMetadata') {
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

        return (
            repoFiles
                .map(normalizePath)
                .find(
                    (repoFile) =>
                        repoFile.endsWith(suffix) &&
                        (!rule.folder ||
                            repoFile.includes(`/${rule.folder}/`)) &&
                        basenameWithoutSuffix(repoFile, suffix) === name
                ) || null
        );
    }
};

module.exports = genericFileArtifactResolver;
