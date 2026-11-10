'use strict';

/**
 * Stable artifact IDs for sealed merge handoff (scoped to mergeManifestId).
 */

const ARTIFACT_ROLE = Object.freeze({
    CLS: 'cls',
    META_XML: 'metaXml'
});

function sanitizeMetadataNamePart(metadataName) {
    const raw = String(metadataName || '').trim();
    if (!raw) {
        return 'UNKNOWN';
    }

    const sanitized = raw.replace(/[^A-Za-z0-9_]/g, '_');
    return sanitized || 'UNKNOWN';
}

/**
 * @param {string} mergeManifestId e.g. manifest_<uuid>
 * @param {string} metadataName Apex class name
 * @param {'cls'|'metaXml'} artifactRole
 */
function buildMergeArtifactId(mergeManifestId, metadataName, artifactRole) {
    const manifestPart = String(mergeManifestId || '').trim();
    const role =
        artifactRole === ARTIFACT_ROLE.META_XML
            ? ARTIFACT_ROLE.META_XML
            : ARTIFACT_ROLE.CLS;

    if (!manifestPart || !manifestPart.startsWith('manifest_')) {
        throw new Error('mergeManifestId is required to build artifact IDs.');
    }

    return `${manifestPart}_${sanitizeMetadataNamePart(metadataName)}_${role}`;
}

function isSafeArtifactId(artifactId) {
    const value = String(artifactId || '').trim();
    if (!value || value.length > 200) {
        return false;
    }

    return /^manifest_[0-9a-f-]{36}_[A-Za-z0-9_]+_(cls|metaXml)$/.test(value);
}

module.exports = {
    ARTIFACT_ROLE,
    buildMergeArtifactId,
    sanitizeMetadataNamePart,
    isSafeArtifactId
};
