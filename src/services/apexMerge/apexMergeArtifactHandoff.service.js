'use strict';

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    assertManifestCorrelation,
    findManifestArtifact,
    sha256Utf8,
    ARTIFACT_ROLE
} = require('./apexMergeManifest.service');
const { isSafeArtifactId } = require('./apexMergeArtifactId.service');
const {
    SESSION_STATUS,
    readSessionRaw,
    isSessionExpired,
    purgeSession,
    getSession
} = require('./mergeSession.store');

function normalizeQuery(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const trimmed = String(value).trim();
    return trimmed || null;
}

function requireHandoffCorrelation(query = {}) {
    const comparisonId = normalizeQuery(query.comparisonId);
    const deploymentPlanId = normalizeQuery(query.deploymentPlanId);
    const mergeManifestId = normalizeQuery(query.mergeManifestId);

    if (!comparisonId || !deploymentPlanId || !mergeManifestId) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'comparisonId, deploymentPlanId, and mergeManifestId are required query parameters.'
        );
    }

    return { comparisonId, deploymentPlanId, mergeManifestId };
}

function loadSealedSessionForHandoff(mergeSessionId) {
    const id = String(mergeSessionId || '').trim();

    if (!id) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'mergeSessionId is required.'
        );
    }

    const raw = readSessionRaw(id);

    if (!raw) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_NOT_FOUND,
            'Merge session was not found or has expired.'
        );
    }

    if (isSessionExpired(raw)) {
        purgeSession(id);
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_EXPIRED,
            'Merge session has expired.'
        );
    }

  if (raw.status !== SESSION_STATUS.SEALED || !raw.manifest) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_NOT_SEALED,
            'Merge session must be sealed before artifacts can be retrieved.',
            { status: raw.status }
        );
    }

    if (raw.mergeSessionId !== id) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'mergeSessionId does not match session record.'
        );
    }

    return raw;
}

function resolveSessionUnit(session, metadataName) {
    const target = String(metadataName || '').trim();
    return (session.classes || []).find(
        (unit) => unit.metadataName === target
    );
}

function readArtifactContent(session, unit, artifactRole) {
    const artifacts = unit?.artifacts;

    if (!artifacts) {
        return null;
    }

    if (artifactRole === ARTIFACT_ROLE.CLS) {
        return artifacts.cls?.content ?? null;
    }

    return artifacts.metaXml?.content ?? null;
}

function verifyArtifactIntegrity(content, descriptor, artifactId) {
    const normalized = String(content ?? '');
    const actualHash = sha256Utf8(normalized);
    const actualLength = Buffer.byteLength(normalized, 'utf8');

    if (actualHash !== descriptor.sha256) {
        throw new ApexMergeError(
            MERGE_ERROR.HASH_MISMATCH,
            'Sealed artifact content does not match manifest SHA-256.',
            {
                artifactId,
                expectedSha256: descriptor.sha256,
                actualSha256: actualHash
            }
        );
    }

    if (actualLength !== descriptor.byteLength) {
        throw new ApexMergeError(
            MERGE_ERROR.HASH_MISMATCH,
            'Sealed artifact byteLength does not match manifest.',
            {
                artifactId,
                expectedByteLength: descriptor.byteLength,
                actualByteLength: actualLength
            }
        );
    }

    return Buffer.from(normalized, 'utf8');
}

/**
 * Retrieve verified UTF-8 artifact bytes for Salesforce handoff (Phase 1.6a).
 */
function retrieveSealedMergeArtifact({
    mergeSessionId,
    artifactId,
    comparisonId,
    deploymentPlanId,
    mergeManifestId
} = {}) {
    const normalizedArtifactId = String(artifactId || '').trim();

    if (!isSafeArtifactId(normalizedArtifactId)) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'artifactId format is invalid.'
        );
    }

    const session = loadSealedSessionForHandoff(mergeSessionId);
    const manifest = session.manifest;

    assertManifestCorrelation(manifest, {
        comparisonId,
        deploymentPlanId,
        mergeManifestId
    });

    if (manifest.mergeSessionId !== session.mergeSessionId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'Manifest mergeSessionId does not match session.'
        );
    }

    const located = findManifestArtifact(manifest, normalizedArtifactId);

    if (!located) {
        throw new ApexMergeError(
            MERGE_ERROR.ARTIFACT_NOT_FOUND,
            'Artifact was not found in the sealed manifest.',
            { artifactId: normalizedArtifactId }
        );
    }

    const unit = resolveSessionUnit(session, located.unit.metadataName);

    if (!unit) {
        throw new ApexMergeError(
            MERGE_ERROR.ARTIFACT_NOT_FOUND,
            'Artifact unit is not present in the sealed session.',
            { artifactId: normalizedArtifactId }
        );
    }

    const content = readArtifactContent(
        session,
        unit,
        located.artifactRole
    );

    if (content === null || content === undefined) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_REQUIRED_ARTIFACT,
            'Sealed artifact content is missing from the session.',
            { artifactId: normalizedArtifactId }
        );
    }

    return verifyArtifactIntegrity(
        content,
        located.descriptor,
        normalizedArtifactId
    );
}

function getSealedSessionForHandoff(mergeSessionId, query = {}) {
    const correlation = requireHandoffCorrelation(query);
    const session = loadSealedSessionForHandoff(mergeSessionId);

    assertManifestCorrelation(session.manifest, correlation);

    if (session.mergeSessionId !== String(mergeSessionId).trim()) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'mergeSessionId does not match session.'
        );
    }

    return session;
}

module.exports = {
    retrieveSealedMergeArtifact,
    getSealedSessionForHandoff,
    requireHandoffCorrelation,
    loadSealedSessionForHandoff
};
