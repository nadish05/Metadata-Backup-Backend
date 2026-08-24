'use strict';

const crypto = require('crypto');

const {
    SCHEMA_VERSION,
    SNAPSHOT_VERSION,
    SNAPSHOT_STATUS,
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    memberIdentityKey
} = require('./snapshot.types');
const {
    SnapshotValidationError,
    SnapshotNotFoundError,
    SnapshotAlreadySealedError,
    SnapshotIntegrityError,
    SnapshotMemberConflictError,
    SnapshotStateError
} = require('./snapshot.errors');
const {
    assertMetadataStore
} = require('./stores/snapshotMetadataStore');
const { assertBlobStore } = require('./stores/snapshotBlobStore');
const {
    hashBytes,
    toBuffer,
    computeSnapshotIntegrityHash,
    hashesMatch
} = require('./snapshotIntegrity.service');

function nowIso() {
    return new Date().toISOString();
}

function generateSnapshotId() {
    return `snapshot_${crypto.randomUUID()}`;
}

function buildArtifactId(snapshotId, metadataType, metadataName) {
    const safeType = encodeURIComponent(metadataType);
    const safeName = encodeURIComponent(metadataName);

    return `snapshots/${snapshotId}/destination-before/${safeType}/${safeName}`;
}

function cloneSnapshot(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
}

function assertStores(metadataStore, blobStore) {
    assertMetadataStore(metadataStore);
    assertBlobStore(blobStore);
}

function validateDeploymentContext(deploymentContext = {}) {
    if (!deploymentContext || typeof deploymentContext !== 'object') {
        throw new SnapshotValidationError('deploymentContext is required.');
    }

    if (!deploymentContext.destinationOrgId) {
        throw new SnapshotValidationError(
            'destinationOrgId is required to capture a snapshot.'
        );
    }
}

function validateMemberIdentity(member) {
    if (!member || typeof member !== 'object') {
        throw new SnapshotValidationError('Snapshot member is required.');
    }

    if (!member.metadataType) {
        throw new SnapshotValidationError('metadataType is required.');
    }

    if (!member.metadataName) {
        throw new SnapshotValidationError('metadataName is required.');
    }

    const changeClass = member.changeClass;

    if (
        changeClass !== CHANGE_CLASS.MODIFIED &&
        changeClass !== CHANGE_CLASS.NEW &&
        changeClass !== CHANGE_CLASS.UNKNOWN
    ) {
        throw new SnapshotValidationError(
            `Invalid changeClass: ${changeClass}`
        );
    }
}

function membersAreIdentical(existing, incoming) {
    return (
        existing.changeClass === incoming.changeClass &&
        existing.existedBefore === incoming.existedBefore &&
        existing.destinationBeforeHash === incoming.destinationBeforeHash &&
        existing.artifactId === incoming.artifactId
    );
}

function createSnapshotCaptureService({ metadataStore, blobStore } = {}) {
    assertStores(metadataStore, blobStore);

    async function requireSnapshot(snapshotId) {
        if (!snapshotId) {
            throw new SnapshotValidationError('snapshotId is required.');
        }

        const snapshot = await metadataStore.getSnapshot(snapshotId);

        if (!snapshot) {
            throw new SnapshotNotFoundError(snapshotId);
        }

        return snapshot;
    }

    async function assertWritable(snapshot) {
        if (snapshot.status === SNAPSHOT_STATUS.SEALED) {
            throw new SnapshotAlreadySealedError(snapshot.snapshotId);
        }

        if (
            snapshot.status !== SNAPSHOT_STATUS.CAPTURING &&
            snapshot.status !== SNAPSHOT_STATUS.READY
        ) {
            throw new SnapshotStateError(
                `Members can only be added while CAPTURING or READY (status=${snapshot.status}).`
            );
        }
    }

    async function markFailed(snapshotId, captureFailureReason) {
        const snapshot = await metadataStore.getSnapshot(snapshotId);

        if (!snapshot || snapshot.status === SNAPSHOT_STATUS.SEALED) {
            return snapshot;
        }

        return metadataStore.updateSnapshot(snapshotId, {
            status: SNAPSHOT_STATUS.FAILED,
            rollbackEligible: false,
            completedAt: nowIso(),
            captureFailureReason
        });
    }

    async function createSnapshot(deploymentContext = {}) {
        validateDeploymentContext(deploymentContext);

        const createdAt = nowIso();
        const snapshot = {
            snapshotId: generateSnapshotId(),
            deploymentId: deploymentContext.deploymentId || null,
            sourceOrgId: deploymentContext.sourceOrgId || null,
            destinationOrgId: deploymentContext.destinationOrgId,
            sourceBranch: deploymentContext.sourceBranch || null,
            destinationBranch: deploymentContext.destinationBranch || null,
            createdAt,
            completedAt: null,
            sealedAt: null,
            status: SNAPSHOT_STATUS.CAPTURING,
            schemaVersion: SCHEMA_VERSION,
            snapshotVersion: SNAPSHOT_VERSION,
            overallIntegrityHash: null,
            rollbackEligible: false,
            captureFailureReason: null,
            memberCount: 0
        };

        return metadataStore.createSnapshot(snapshot);
    }

    async function persistModifiedMember(snapshot, member) {
        const bytes = toBuffer(member.destinationBeforeBytes);

        if (!bytes || bytes.length === 0) {
            throw new SnapshotValidationError(
                `MODIFIED member ${member.metadataType}:${member.metadataName} requires destination-before bytes.`
            );
        }

        const destinationBeforeHash = hashBytes(bytes);
        const artifactId = buildArtifactId(
            snapshot.snapshotId,
            member.metadataType,
            member.metadataName
        );

        const stored = await blobStore.putArtifact({
            artifactId,
            bytes
        });

        return {
            snapshotId: snapshot.snapshotId,
            metadataType: member.metadataType,
            metadataName: member.metadataName,
            filePath: member.filePath || member.logicalPath || null,
            changeClass: CHANGE_CLASS.MODIFIED,
            existedBefore: true,
            destinationBeforeHash,
            artifactId,
            artifactSize: stored.size,
            captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE
        };
    }

    function buildNewMember(snapshot, member) {
        if (toBuffer(member.destinationBeforeBytes)) {
            throw new SnapshotValidationError(
                `NEW member ${member.metadataType}:${member.metadataName} must not include destination-before bytes.`
            );
        }

        return {
            snapshotId: snapshot.snapshotId,
            metadataType: member.metadataType,
            metadataName: member.metadataName,
            filePath: member.filePath || member.logicalPath || null,
            changeClass: CHANGE_CLASS.NEW,
            existedBefore: false,
            destinationBeforeHash: null,
            artifactId: null,
            artifactSize: 0,
            captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN
        };
    }

    function buildUnknownMember(snapshot, member) {
        if (toBuffer(member.destinationBeforeBytes)) {
            throw new SnapshotValidationError(
                `UNKNOWN member ${member.metadataType}:${member.metadataName} must not include destination-before bytes.`
            );
        }

        return {
            snapshotId: snapshot.snapshotId,
            metadataType: member.metadataType,
            metadataName: member.metadataName,
            filePath: member.filePath || member.logicalPath || null,
            changeClass: CHANGE_CLASS.UNKNOWN,
            existedBefore: null,
            destinationBeforeHash: null,
            artifactId: null,
            artifactSize: 0,
            captureStatus: MEMBER_CAPTURE_STATUS.UNKNOWN
        };
    }

    async function addMember(snapshotId, memberInput) {
        const snapshot = await requireSnapshot(snapshotId);
        await assertWritable(snapshot);
        validateMemberIdentity(memberInput);

        const existing = await metadataStore.getMember(
            snapshotId,
            memberInput.metadataType,
            memberInput.metadataName
        );

        if (existing && memberInput.changeClass === CHANGE_CLASS.MODIFIED) {
            const incomingBytes = toBuffer(memberInput.destinationBeforeBytes);

            if (!incomingBytes || incomingBytes.length === 0) {
                throw new SnapshotValidationError(
                    `MODIFIED member ${memberInput.metadataType}:${memberInput.metadataName} requires destination-before bytes.`
                );
            }

            const incomingHash = hashBytes(incomingBytes);

            if (
                existing.changeClass === CHANGE_CLASS.MODIFIED &&
                existing.destinationBeforeHash === incomingHash
            ) {
                return existing;
            }

            throw new SnapshotMemberConflictError(
                `Conflicting snapshot member already exists for ${memberIdentityKey(
                    memberInput.metadataType,
                    memberInput.metadataName
                )}.`
            );
        }

        let nextMember;

        if (memberInput.changeClass === CHANGE_CLASS.MODIFIED) {
            nextMember = await persistModifiedMember(snapshot, memberInput);
        } else if (memberInput.changeClass === CHANGE_CLASS.NEW) {
            nextMember = buildNewMember(snapshot, memberInput);
        } else {
            nextMember = buildUnknownMember(snapshot, memberInput);
        }

        if (existing) {
            if (membersAreIdentical(existing, nextMember)) {
                return existing;
            }

            throw new SnapshotMemberConflictError(
                `Conflicting snapshot member already exists for ${memberIdentityKey(
                    nextMember.metadataType,
                    nextMember.metadataName
                )}.`
            );
        }

        const stored = await metadataStore.addMember(nextMember);
        const members = await metadataStore.getMembers(snapshotId);

        await metadataStore.updateSnapshot(snapshotId, {
            memberCount: members.length
        });

        return stored;
    }

    function computeRollbackEligible(members) {
        if (!members.length) {
            return false;
        }

        return members.every(
            (member) =>
                member.changeClass === CHANGE_CLASS.MODIFIED &&
                member.captureStatus === MEMBER_CAPTURE_STATUS.COMPLETE &&
                member.destinationBeforeHash &&
                member.artifactId
        );
    }

    async function finalizeCapture(snapshotId) {
        const snapshot = await requireSnapshot(snapshotId);

        if (snapshot.status === SNAPSHOT_STATUS.SEALED) {
            throw new SnapshotAlreadySealedError(snapshotId);
        }

        if (snapshot.status === SNAPSHOT_STATUS.FAILED) {
            throw new SnapshotStateError(
                'FAILED snapshots cannot be finalized. Create a new snapshot.'
            );
        }

        if (snapshot.status === SNAPSHOT_STATUS.READY) {
            return snapshot;
        }

        const members = await metadataStore.getMembers(snapshotId);

        if (!members.length) {
            return markFailed(
                snapshotId,
                'Cannot finalize a snapshot with no members.'
            );
        }

        const failedMember = members.find(
            (member) => member.captureStatus === MEMBER_CAPTURE_STATUS.FAILED
        );

        if (failedMember) {
            return markFailed(
                snapshotId,
                `Member capture failed: ${memberIdentityKey(
                    failedMember.metadataType,
                    failedMember.metadataName
                )}`
            );
        }

        return metadataStore.updateSnapshot(snapshotId, {
            status: SNAPSHOT_STATUS.READY,
            completedAt: nowIso(),
            rollbackEligible: false
        });
    }

    async function verifyMemberArtifacts(members) {
        for (const member of members) {
            if (member.changeClass !== CHANGE_CLASS.MODIFIED) {
                if (member.artifactId || member.destinationBeforeHash) {
                    throw new SnapshotIntegrityError(
                        `Member ${memberIdentityKey(
                            member.metadataType,
                            member.metadataName
                        )} must not have a destination-before artifact.`
                    );
                }

                continue;
            }

            if (!member.artifactId || !member.destinationBeforeHash) {
                throw new SnapshotIntegrityError(
                    `MODIFIED member ${memberIdentityKey(
                        member.metadataType,
                        member.metadataName
                    )} is missing destination-before artifact or hash.`
                );
            }

            const exists = await blobStore.exists(member.artifactId);

            if (!exists) {
                throw new SnapshotIntegrityError(
                    `Destination-before artifact missing: ${member.artifactId}`
                );
            }

            const bytes = await blobStore.getArtifact(member.artifactId);

            if (!bytes || bytes.length === 0) {
                throw new SnapshotIntegrityError(
                    `Destination-before artifact is empty: ${member.artifactId}`
                );
            }

            const actualHash = hashBytes(bytes);

            if (!hashesMatch(member.destinationBeforeHash, actualHash)) {
                throw new SnapshotIntegrityError(
                    `Destination-before hash mismatch for ${memberIdentityKey(
                        member.metadataType,
                        member.metadataName
                    )}.`
                );
            }
        }
    }

    async function verifySnapshotIntegrity(snapshotId) {
        const snapshot = await requireSnapshot(snapshotId);
        const members = await metadataStore.getMembers(snapshotId);

        await verifyMemberArtifacts(members);

        const overallIntegrityHash = computeSnapshotIntegrityHash(members);

        return {
            ok: true,
            overallIntegrityHash,
            snapshot,
            members
        };
    }

    async function sealSnapshot(snapshotId) {
        const snapshot = await requireSnapshot(snapshotId);

        if (snapshot.status === SNAPSHOT_STATUS.SEALED) {
            throw new SnapshotAlreadySealedError(snapshotId);
        }

        if (snapshot.status === SNAPSHOT_STATUS.FAILED) {
            throw new SnapshotStateError(
                'FAILED snapshots cannot be sealed. Create a new snapshot.'
            );
        }

        if (snapshot.status !== SNAPSHOT_STATUS.READY) {
            throw new SnapshotStateError(
                `Only READY snapshots can be sealed (status=${snapshot.status}).`
            );
        }

        let integrity;

        try {
            integrity = await verifySnapshotIntegrity(snapshotId);
        } catch (error) {
            if (error instanceof SnapshotIntegrityError) {
                await markFailed(snapshotId, error.message);
            }

            throw error;
        }

        const sealedAt = nowIso();
        const rollbackEligible = computeRollbackEligible(integrity.members);

        return metadataStore.sealSnapshot(snapshotId, {
            sealedAt,
            completedAt: snapshot.completedAt || sealedAt,
            overallIntegrityHash: integrity.overallIntegrityHash,
            rollbackEligible,
            captureFailureReason: null
        });
    }

    async function captureSnapshot({
        deploymentContext,
        members
    } = {}) {
        validateDeploymentContext(deploymentContext);

        if (!Array.isArray(members) || members.length === 0) {
            throw new SnapshotValidationError(
                'At least one snapshot member is required.'
            );
        }

        const snapshot = await createSnapshot(deploymentContext);

        try {
            for (const member of members) {
                await addMember(snapshot.snapshotId, member);
            }

            return finalizeCapture(snapshot.snapshotId);
        } catch (error) {
            if (
                !(error instanceof SnapshotAlreadySealedError) &&
                !(error instanceof SnapshotNotFoundError)
            ) {
                await markFailed(snapshot.snapshotId, error.message);
            }

            error.snapshotId = snapshot.snapshotId;
            throw error;
        }
    }

    async function getSnapshot(snapshotId) {
        return requireSnapshot(snapshotId);
    }

    async function getMembers(snapshotId) {
        await requireSnapshot(snapshotId);

        return metadataStore.getMembers(snapshotId);
    }

    return {
        createSnapshot,
        addMember,
        captureSnapshot,
        finalizeCapture,
        sealSnapshot,
        verifySnapshotIntegrity,
        getSnapshot,
        getMembers
    };
}

module.exports = {
    createSnapshotCaptureService,
    generateSnapshotId,
    buildArtifactId,
    cloneSnapshot
};
