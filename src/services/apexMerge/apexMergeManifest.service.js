'use strict';

const crypto = require('crypto');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const { hasConflictMarkers } = require('./apexMergeFullClass.service');
const {
    buildMergeArtifactId,
    ARTIFACT_ROLE
} = require('./apexMergeArtifactId.service');

const MANIFEST_SCHEMA_VERSION = 1;

function sha256Utf8(content) {
    return crypto
        .createHash('sha256')
        .update(String(content ?? ''), 'utf8')
        .digest('hex');
}

function buildArtifactDescriptor(content, { artifactId = null } = {}) {
    const normalized = String(content ?? '');
    const descriptor = {
        sha256: sha256Utf8(normalized),
        byteLength: Buffer.byteLength(normalized, 'utf8')
    };

    if (artifactId) {
        descriptor.artifactId = artifactId;
    }

    return descriptor;
}

function generateManifestId() {
    return `manifest_${crypto.randomUUID()}`;
}

/**
 * Build immutable manifest from sealed session units (server-computed hashes).
 */
function buildApexMergeManifest(session) {
    if (!session) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_MANIFEST,
            'Session is required to build a manifest.'
        );
    }

    const mergeManifestId = generateManifestId();

    const units = (session.classes || []).map((unit) => {
        if (unit.conflictState !== 'RESOLVED' && unit.conflictState !== 'NONE') {
            throw new ApexMergeError(
                MERGE_ERROR.UNRESOLVED_CONFLICT,
                `Class ${unit.metadataName} has unresolved conflicts.`
            );
        }

        const clsContent = unit.artifacts?.cls?.content ?? '';
        const metaContent = unit.artifacts?.metaXml?.content ?? '';

        if (hasConflictMarkers(clsContent) || hasConflictMarkers(metaContent)) {
            throw new ApexMergeError(
                MERGE_ERROR.CONFLICT_MARKERS,
                `Class ${unit.metadataName} contains conflict markers.`
            );
        }

        if (!clsContent) {
            throw new ApexMergeError(
                MERGE_ERROR.MISSING_REQUIRED_ARTIFACT,
                `Class ${unit.metadataName} is missing .cls content.`
            );
        }

        if (!metaContent) {
            throw new ApexMergeError(
                MERGE_ERROR.MISSING_REQUIRED_ARTIFACT,
                `Class ${unit.metadataName} is missing .cls-meta.xml content.`
            );
        }

        return {
            metadataType: 'ApexClass',
            metadataName: unit.metadataName,
            filePath: unit.filePath,
            metaXmlPath: unit.metaXmlPath,
            mergeMode: unit.mergeMode || 'FULL',
            mergeBaseSha: unit.mergeBaseSha,
            conflictState: unit.conflictState,
            artifacts: {
                cls: buildArtifactDescriptor(clsContent, {
                    artifactId: buildMergeArtifactId(
                        mergeManifestId,
                        unit.metadataName,
                        ARTIFACT_ROLE.CLS
                    )
                }),
                metaXml: buildArtifactDescriptor(metaContent, {
                    artifactId: buildMergeArtifactId(
                        mergeManifestId,
                        unit.metadataName,
                        ARTIFACT_ROLE.META_XML
                    )
                })
            }
        };
    });

    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        mergeManifestId,
        mergeSessionId: session.mergeSessionId,
        comparisonId: session.comparisonId,
        deploymentPlanId: session.deploymentPlanId,
        repoUrl: session.repoUrl,
        sourceBranch: session.sourceBranch,
        destinationBranch: session.destinationBranch,
        gitPins: { ...session.gitPins },
        sealedAt: new Date().toISOString(),
        units
    };
}

function verifyManifestAgainstRepoPins(manifest, currentPins) {
    if (!manifest?.gitPins || !currentPins) {
        throw new ApexMergeError(
            MERGE_ERROR.STALE_GIT_PINS,
            'Unable to verify Git pins.'
        );
    }

    if (
        manifest.gitPins.sourceHeadSha !== currentPins.sourceHeadSha ||
        manifest.gitPins.destinationHeadSha !== currentPins.destinationHeadSha
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.STALE_GIT_PINS,
            'Git branch HEAD SHAs do not match the sealed manifest.',
            {
                manifestPins: manifest.gitPins,
                currentPins
            }
        );
    }
}

function verifyManifestUnitHashes(unit, { clsContent, metaContent }) {
    const expectedCls = unit.artifacts?.cls?.sha256;
    const expectedMeta = unit.artifacts?.metaXml?.sha256;
    const actualCls = sha256Utf8(clsContent);
    const actualMeta = sha256Utf8(metaContent);

    if (expectedCls !== actualCls || expectedMeta !== actualMeta) {
        throw new ApexMergeError(
            MERGE_ERROR.HASH_MISMATCH,
            `Artifact hash mismatch for ${unit.metadataName}.`,
            {
                metadataName: unit.metadataName,
                expectedCls,
                actualCls,
                expectedMeta,
                actualMeta
            }
        );
    }
}

function assertManifestCorrelation(
    manifest,
    { comparisonId, deploymentPlanId, mergeManifestId } = {}
) {
    if (mergeManifestId && manifest.mergeManifestId !== mergeManifestId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'mergeManifestId does not match manifest.'
        );
    }
    if (comparisonId && manifest.comparisonId !== comparisonId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'comparisonId does not match manifest.'
        );
    }

    if (deploymentPlanId && manifest.deploymentPlanId !== deploymentPlanId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'deploymentPlanId does not match manifest.'
        );
    }
}

function findManifestArtifact(manifest, artifactId) {
    if (!manifest || !artifactId) {
        return null;
    }

    const targetId = String(artifactId).trim();

    for (const unit of manifest.units || []) {
        const clsId = unit.artifacts?.cls?.artifactId;
        const metaId = unit.artifacts?.metaXml?.artifactId;

        if (clsId === targetId) {
            return {
                unit,
                artifactRole: ARTIFACT_ROLE.CLS,
                descriptor: unit.artifacts.cls
            };
        }

        if (metaId === targetId) {
            return {
                unit,
                artifactRole: ARTIFACT_ROLE.META_XML,
                descriptor: unit.artifacts.metaXml
            };
        }
    }

    return null;
}

module.exports = {
    MANIFEST_SCHEMA_VERSION,
    ARTIFACT_ROLE,
    sha256Utf8,
    buildArtifactDescriptor,
    buildApexMergeManifest,
    verifyManifestAgainstRepoPins,
    verifyManifestUnitHashes,
    assertManifestCorrelation,
    findManifestArtifact,
    generateManifestId
};
