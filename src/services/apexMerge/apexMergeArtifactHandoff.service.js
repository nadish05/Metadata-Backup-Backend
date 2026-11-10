'use strict';

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    assertManifestCorrelation,
    findManifestArtifact,
    sha256Utf8,
    ARTIFACT_ROLE
} = require('./apexMergeManifest.service');
const { isSafeArtifactId } = require('./apexMergeArtifactId.service');
const { OrgLockIdentityError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
const {
    resolveVerifiedDestinationOrgId
} = require('../deploymentOrgLock/destinationOrgIdentity.service');
const {
    SESSION_STATUS,
    readSessionRaw,
    isSessionExpired,
    purgeSession,
    patchSessionRaw,
    computeSessionExpiryMs
} = require('./mergeSession.store');

const DEFAULT_ARTIFACT_HANDOFF_GRANT_MS = 30 * 60 * 1000;

let resolveDestinationOrgIdentity = resolveVerifiedDestinationOrgId;

function setResolveDestinationOrgIdentityForTests(fn) {
    if (typeof fn === 'function') {
        resolveDestinationOrgIdentity = fn;
    }
}

function resetResolveDestinationOrgIdentityForTests() {
    resolveDestinationOrgIdentity = resolveVerifiedDestinationOrgId;
}

function setArtifactHandoffGrantWindowForTests(ms) {
    if (Number.isFinite(ms)) {
        artifactHandoffGrantMs = ms;
    }
}

function resetArtifactHandoffGrantWindowForTests() {
    artifactHandoffGrantMs = DEFAULT_ARTIFACT_HANDOFF_GRANT_MS;
}

let artifactHandoffGrantMs = DEFAULT_ARTIFACT_HANDOFF_GRANT_MS;

function normalizeValue(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const trimmed = String(value).trim();
    return trimmed || null;
}

function requireHandoffCorrelation(input = {}) {
    const comparisonId = normalizeValue(input.comparisonId);
    const deploymentPlanId = normalizeValue(input.deploymentPlanId);
    const mergeManifestId = normalizeValue(input.mergeManifestId);

    if (!comparisonId || !deploymentPlanId || !mergeManifestId) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'comparisonId, deploymentPlanId, and mergeManifestId are required.'
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

function mapIdentityError(error) {
    if (!(error instanceof OrgLockIdentityError)) {
        return new ApexMergeError(
            MERGE_ERROR.DESTINATION_AUTH_FAILED,
            'Destination org authentication failed.'
        );
    }

    const message = String(error.message || '');

    if (message.includes('does not match authenticated org')) {
        return new ApexMergeError(
            MERGE_ERROR.ORG_IDENTITY_MISMATCH,
            'Supplied orgId does not match the authenticated Salesforce organization.',
            { reason: message }
        );
    }

    return new ApexMergeError(
        MERGE_ERROR.DESTINATION_AUTH_FAILED,
        'Destination org authentication failed.',
        { reason: message }
    );
}

function buildGrantExpiryIso(session, referenceTime = Date.now()) {
    const grantWindowExpiry = referenceTime + artifactHandoffGrantMs;
    const sessionExpiry = computeSessionExpiryMs(session, referenceTime);

    return new Date(Math.min(grantWindowExpiry, sessionExpiry)).toISOString();
}

function isArtifactHandoffGrantExpired(grant, session, referenceTime = Date.now()) {
    if (!grant?.authorized) {
        return true;
    }

    const grantExpiry = new Date(grant.expiresAt || 0).getTime();
    if (!Number.isFinite(grantExpiry) || referenceTime >= grantExpiry) {
        return true;
    }

    return isSessionExpired(session, referenceTime);
}

function assertArtifactHandoffGrant(session, correlation) {
    const grant = session?.artifactHandoff;

    if (!grant?.authorized || isArtifactHandoffGrantExpired(grant, session)) {
        throw new ApexMergeError(
            MERGE_ERROR.ARTIFACT_HANDOFF_NOT_AUTHORIZED,
            'Artifact handoff is not authorized for this merge session.',
            { mergeSessionId: session.mergeSessionId }
        );
    }

    if (
        grant.mergeSessionId &&
        grant.mergeSessionId !== session.mergeSessionId
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.ARTIFACT_HANDOFF_NOT_AUTHORIZED,
            'Artifact handoff grant does not belong to this session.'
        );
    }

    if (
        grant.comparisonId !== correlation.comparisonId ||
        grant.deploymentPlanId !== correlation.deploymentPlanId ||
        grant.mergeManifestId !== correlation.mergeManifestId
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'Artifact handoff grant does not match the requested correlation.'
        );
    }
}

function requireOAuthCredentials(body = {}) {
    const refreshToken = normalizeValue(body.refreshToken);
    const instanceUrl = normalizeValue(body.instanceUrl);
    const orgId = normalizeValue(body.orgId);

    if (!refreshToken || !instanceUrl || !orgId) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'refreshToken, instanceUrl, and orgId are required.'
        );
    }

    return { refreshToken, instanceUrl, orgId };
}

async function authorizeArtifactHandoff(mergeSessionId, body = {}) {
    const session = loadSealedSessionForHandoff(mergeSessionId);
    const correlation = requireHandoffCorrelation(body);
    const credentials = requireOAuthCredentials(body);

    assertManifestCorrelation(session.manifest, correlation);

    if (session.manifest.mergeSessionId !== session.mergeSessionId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'Manifest mergeSessionId does not match session.'
        );
    }

    let verifiedOrgId;

    try {
        verifiedOrgId = await resolveDestinationOrgIdentity({
            refreshToken: credentials.refreshToken,
            instanceUrl: credentials.instanceUrl,
            requestedOrgId: credentials.orgId
        });
    } catch (error) {
        throw mapIdentityError(error);
    }

    if (!verifiedOrgId) {
        throw new ApexMergeError(
            MERGE_ERROR.DESTINATION_AUTH_FAILED,
            'Destination org authentication failed.'
        );
    }

    const authorizedAt = new Date().toISOString();
    const expiresAt = buildGrantExpiryIso(session);

    const artifactHandoff = {
        authorized: true,
        verifiedOrgId,
        mergeSessionId: session.mergeSessionId,
        comparisonId: correlation.comparisonId,
        deploymentPlanId: correlation.deploymentPlanId,
        mergeManifestId: correlation.mergeManifestId,
        authorizedAt,
        expiresAt
    };

    patchSessionRaw(mergeSessionId, { artifactHandoff });

    return {
        success: true,
        authorized: true,
        mergeSessionId: session.mergeSessionId,
        mergeManifestId: correlation.mergeManifestId,
        verifiedOrgId,
        expiresAt
    };
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
    const correlation = requireHandoffCorrelation({
        comparisonId,
        deploymentPlanId,
        mergeManifestId
    });

    assertManifestCorrelation(session.manifest, correlation);
    assertArtifactHandoffGrant(session, correlation);

    if (session.manifest.mergeSessionId !== session.mergeSessionId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'Manifest mergeSessionId does not match session.'
        );
    }

    const located = findManifestArtifact(session.manifest, normalizedArtifactId);

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

module.exports = {
    DEFAULT_ARTIFACT_HANDOFF_GRANT_MS,
    authorizeArtifactHandoff,
    retrieveSealedMergeArtifact,
    requireHandoffCorrelation,
    loadSealedSessionForHandoff,
    assertArtifactHandoffGrant,
    isArtifactHandoffGrantExpired,
    buildGrantExpiryIso,
    setResolveDestinationOrgIdentityForTests,
    resetResolveDestinationOrgIdentityForTests,
    setArtifactHandoffGrantWindowForTests,
    resetArtifactHandoffGrantWindowForTests
};
