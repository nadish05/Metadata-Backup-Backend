/**
 * Deployable Metadata Normalizer — foundation only (Phase 1).
 *
 * Converts physical metadata file rows into logical deployable components.
 * Not wired into Review, Validation, Package, Manifest, or Deploy yet.
 *
 * Public API: normalizeDeployableMetadata(selectedMetadata)
 */

const {
    METADATA_KINDS,
    getMetadataTypeRule
} = require('../config/metadataTypes');

const LIGHTNING_COMPONENT_BUNDLE = 'LightningComponentBundle';

function normalizePath(filePath) {
    if (!filePath) {
        return null;
    }

    return String(filePath).replace(/\\/g, '/');
}

function extractBundleNameFromPath(filePath, folder) {
    const normalized = normalizePath(filePath);

    if (!normalized || !folder) {
        return null;
    }

    const marker = `/${folder}/`;
    const markerIndex = normalized.indexOf(marker);

    if (markerIndex === -1) {
        return null;
    }

    const afterFolder = normalized.slice(markerIndex + marker.length);
    const bundleName = afterFolder.split('/')[0];

    return bundleName || null;
}

function resolveBundleDescriptorPath(metadataType, metadataName, filePath) {
    const rule = getMetadataTypeRule(metadataType);

    if (!rule || rule.kind !== METADATA_KINDS.BUNDLE || !metadataName) {
        return null;
    }

    const descriptorFileName = `${metadataName}${rule.descriptorExtension}`;
    const normalizedFilePath = normalizePath(filePath);

    if (normalizedFilePath) {
        if (normalizedFilePath.endsWith(descriptorFileName)) {
            return normalizedFilePath;
        }

        const marker = `/${rule.folder}/${metadataName}/`;
        const markerIndex = normalizedFilePath.indexOf(marker);

        if (markerIndex !== -1) {
            return (
                normalizedFilePath.slice(0, markerIndex + marker.length) +
                descriptorFileName
            );
        }
    }

    return `force-app/main/default/${rule.folder}/${metadataName}/${descriptorFileName}`;
}

/**
 * Phase 1: LightningComponentBundle only.
 * Returns logical identity when the item is (or clearly is) an LWC member file.
 */
function resolveLightningComponentBundleIdentity(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const metadataType = item.metadataType || item.type || null;
    const filePath = normalizePath(item.filePath || item.path || null);
    const rule = getMetadataTypeRule(LIGHTNING_COMPONENT_BUNDLE);

    if (!rule || rule.kind !== METADATA_KINDS.BUNDLE) {
        return null;
    }

    const pathBundleName = extractBundleNameFromPath(filePath, rule.folder);
    const explicitName = item.metadataName || item.name || null;

    // Explicit LCB type → logical bundle (name from path preferred, then explicit).
    if (metadataType === LIGHTNING_COMPONENT_BUNDLE) {
        const metadataName = pathBundleName || explicitName;

        if (!metadataName) {
            return null;
        }

        return {
            metadataType: LIGHTNING_COMPONENT_BUNDLE,
            metadataName
        };
    }

    // Untyped row with a clear /lwc/<bundle>/ path → treat as LCB member.
    if (!metadataType && pathBundleName) {
        return {
            metadataType: LIGHTNING_COMPONENT_BUNDLE,
            metadataName: pathBundleName
        };
    }

    return null;
}

function collectSourceFilePath(item) {
    return normalizePath(item?.filePath || item?.path || null);
}

function createLogicalLightningComponentBundle(identity, item) {
    const sourceFile = collectSourceFilePath(item);
    const filePath =
        resolveBundleDescriptorPath(
            identity.metadataType,
            identity.metadataName,
            sourceFile
        ) || sourceFile;

    return {
        metadataType: identity.metadataType,
        metadataName: identity.metadataName,
        filePath,
        // Reserved for future expansion — not consumed by any workflow yet.
        sourceFiles: sourceFile ? [sourceFile] : []
    };
}

function mergeIntoLogicalBundle(logical, item) {
    const sourceFile = collectSourceFilePath(item);

    if (!sourceFile) {
        return logical;
    }

    if (!Array.isArray(logical.sourceFiles)) {
        logical.sourceFiles = [];
    }

    if (!logical.sourceFiles.includes(sourceFile)) {
        logical.sourceFiles.push(sourceFile);
    }

    const descriptorPath = resolveBundleDescriptorPath(
        logical.metadataType,
        logical.metadataName,
        sourceFile
    );

    if (descriptorPath) {
        logical.filePath = descriptorPath;
    }

    return logical;
}

function passThroughUnchanged(item) {
    return { ...item };
}

/**
 * Normalize physical selectedMetadata rows into logical deployable components.
 *
 * Phase 1 behavior:
 * - Collapse LightningComponentBundle member files into one component per bundle
 * - Pass all other metadata through unchanged
 *
 * @param {Array<object>|null|undefined} selectedMetadata
 * @returns {Array<object>} normalizedSelectedMetadata
 */
function normalizeDeployableMetadata(selectedMetadata) {
    if (!Array.isArray(selectedMetadata)) {
        return [];
    }

    const normalized = [];
    const bundleIndexByKey = new Map();

    for (const item of selectedMetadata) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const identity = resolveLightningComponentBundleIdentity(item);

        if (!identity) {
            // Non-LWC (and other future bundle types until supported): pass through.
            normalized.push(passThroughUnchanged(item));
            continue;
        }

        const key = `${identity.metadataType}:${identity.metadataName}`;

        if (bundleIndexByKey.has(key)) {
            const index = bundleIndexByKey.get(key);
            mergeIntoLogicalBundle(normalized[index], item);
            continue;
        }

        bundleIndexByKey.set(key, normalized.length);
        normalized.push(createLogicalLightningComponentBundle(identity, item));
    }

    return normalized;
}

module.exports = {
    normalizeDeployableMetadata
};
