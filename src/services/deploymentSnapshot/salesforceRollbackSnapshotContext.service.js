'use strict';

/**
 * Stage 2A — Build an ephemeral in-memory capture context from a Salesforce
 * rollback payload (snapshotExport + base64 artifacts). Does not execute rollback.
 */

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS,
    SNAPSHOT_STATUS
} = require('./snapshot.types');
const { createSnapshotCaptureService } = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const { assertSafeSnapshotArtifactId } = require('./snapshotArtifactId.service');
const {
    ROLLBACK_MODE,
    isDeleteRollbackEligibleMember
} = require('./snapshotRollbackEligibility.service');
const {
    NODE_CAPTURE_STATUS,
    toNodeCaptureStatus
} = require('../controlPlane/controlPlane.captureStatus');

const SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE = Object.freeze({
    INVALID_REQUEST: 'ROLLBACK_SNAPSHOT_CONTEXT_INVALID_REQUEST',
    UNSUPPORTED_MEMBER: 'ROLLBACK_SNAPSHOT_CONTEXT_UNSUPPORTED_MEMBER',
    ARTIFACT_MISSING: 'ROLLBACK_SNAPSHOT_CONTEXT_ARTIFACT_MISSING',
    ARTIFACT_SIZE_MISMATCH: 'ROLLBACK_SNAPSHOT_CONTEXT_ARTIFACT_SIZE_MISMATCH',
    ARTIFACT_INVALID: 'ROLLBACK_SNAPSHOT_CONTEXT_ARTIFACT_INVALID'
});

const NODE_CAPTURE_STATUS_VALUES = new Set(
    Object.values(NODE_CAPTURE_STATUS)
);

const MEMBER_FIELDS = Object.freeze([
    'memberKey',
    'metadataType',
    'metadataName',
    'filePath',
    'changeClass',
    'existedBefore',
    'destinationBeforeHash',
    'expectedAfterHash',
    'artifactId',
    'artifactSize',
    'contentDocumentId',
    'captureStatus'
]);

class SalesforceRollbackSnapshotContextError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SalesforceRollbackSnapshotContextError';
        this.code = code;
    }
}

function reject(code, message) {
    throw new SalesforceRollbackSnapshotContextError(code, message);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCaptureStatus(captureStatus) {
    if (NODE_CAPTURE_STATUS_VALUES.has(captureStatus)) {
        return captureStatus;
    }

    return toNodeCaptureStatus(captureStatus);
}

function pickMemberFields(member, snapshotId) {
    const stored = { snapshotId };

    for (const field of MEMBER_FIELDS) {
        if (member[field] !== undefined) {
            stored[field] =
                field === 'captureStatus'
                    ? normalizeCaptureStatus(member.captureStatus)
                    : member[field];
        }
    }

    return stored;
}

function buildSnapshotRecord(snapshotExport) {
    const {
        members: _members,
        ...snapshotFields
    } = snapshotExport;

    const record = { ...snapshotFields };

    if (record.status === SNAPSHOT_STATUS.SEALED) {
        record.status = SNAPSHOT_STATUS.READY;
    }

    return record;
}

function decodeArtifactBase64(contentBase64, { artifactId, expectedSize } = {}) {
    if (typeof contentBase64 !== 'string' || !contentBase64.trim()) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID,
            `Artifact ${artifactId || '(unknown)'} is missing contentBase64.`
        );
    }

    let bytes;

    try {
        bytes = Buffer.from(contentBase64, 'base64');
    } catch (error) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID,
            `Artifact ${artifactId || '(unknown)'} has invalid base64 content.`
        );
    }

    if (!bytes || bytes.length === 0) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID,
            `Artifact ${artifactId || '(unknown)'} decoded to empty bytes.`
        );
    }

    const normalizedInput = contentBase64.replace(/\s+/g, '');

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedInput)) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID,
            `Artifact ${artifactId || '(unknown)'} has malformed base64 content.`
        );
    }

    if (
        expectedSize !== undefined &&
        expectedSize !== null &&
        Number(expectedSize) !== bytes.length
    ) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_SIZE_MISMATCH,
            `Artifact ${artifactId || '(unknown)'} size ${expectedSize} does not match decoded byte length ${bytes.length}.`
        );
    }

    return bytes;
}

function classifyMemberRollbackIntent(member) {
    if (member.changeClass === CHANGE_CLASS.MODIFIED) {
        return ROLLBACK_MODE.RESTORE;
    }

    if (member.changeClass === CHANGE_CLASS.NEW) {
        return ROLLBACK_MODE.DELETE;
    }

    return 'UNSUPPORTED';
}

function assertRollbackSnapshotMembers(members) {
    const normalizedMembers = members.map((member) => ({
        ...member,
        captureStatus: normalizeCaptureStatus(member.captureStatus)
    }));
    const intents = new Set(
        normalizedMembers.map((member) => classifyMemberRollbackIntent(member))
    );

    if (intents.has('UNSUPPORTED')) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.UNSUPPORTED_MEMBER,
            'Stage 2A supports MODIFIED restore or delete-eligible NEW members only.'
        );
    }

    if (intents.has(ROLLBACK_MODE.RESTORE) && intents.has(ROLLBACK_MODE.DELETE)) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.UNSUPPORTED_MEMBER,
            'Stage 2A v1 does not support mixed MODIFIED restore and NEW delete members.'
        );
    }

    if (intents.has(ROLLBACK_MODE.DELETE)) {
        for (const member of normalizedMembers) {
            if (!isDeleteRollbackEligibleMember(member)) {
                reject(
                    SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.UNSUPPORTED_MEMBER,
                    `Delete rollback requires NEW member with ABSENT_PROVEN capture and expectedAfterHash; found unsupported NEW for ${member.metadataType}:${member.metadataName}.`
                );
            }
        }

        return ROLLBACK_MODE.DELETE;
    }

    return ROLLBACK_MODE.RESTORE;
}

async function createSalesforceRollbackSnapshotContext(
    snapshotExport,
    artifacts
) {
    if (!isPlainObject(snapshotExport)) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
            'snapshotExport is required.'
        );
    }

    const snapshotId = snapshotExport.snapshotId;

    if (typeof snapshotId !== 'string' || !snapshotId.trim()) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
            'snapshotExport.snapshotId is required.'
        );
    }

    if (!Array.isArray(snapshotExport.members)) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
            'snapshotExport.members must be an array.'
        );
    }

    if (!isPlainObject(artifacts)) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
            'artifacts map is required.'
        );
    }

    const members = snapshotExport.members;

    if (members.length === 0) {
        reject(
            SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
            'snapshotExport.members must not be empty.'
        );
    }

    const rollbackMode = assertRollbackSnapshotMembers(members);

    const metadataStore = createMemorySnapshotMetadataStore();
    const blobStore = createMemorySnapshotBlobStore();
    const captureService = createSnapshotCaptureService({
        metadataStore,
        blobStore
    });

    const exportWasSealed = snapshotExport.status === SNAPSHOT_STATUS.SEALED;
    const snapshotRecord = buildSnapshotRecord(snapshotExport);

    await metadataStore.createSnapshot(snapshotRecord);

    for (const member of members) {
        const storedMember = pickMemberFields(member, snapshotId.trim());

        if (!storedMember.metadataType || !storedMember.metadataName) {
            reject(
                SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.INVALID_REQUEST,
                'Each snapshot member requires metadataType and metadataName.'
            );
        }

        if (rollbackMode === ROLLBACK_MODE.DELETE) {
            if (storedMember.artifactId) {
                reject(
                    SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_INVALID,
                    `Delete-eligible NEW member ${storedMember.metadataType}:${storedMember.metadataName} must not include artifactId.`
                );
            }

            if (
                storedMember.changeClass !== CHANGE_CLASS.NEW ||
                storedMember.captureStatus !== MEMBER_CAPTURE_STATUS.ABSENT_PROVEN ||
                !storedMember.expectedAfterHash
            ) {
                reject(
                    SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.UNSUPPORTED_MEMBER,
                    `Delete-eligible NEW member ${storedMember.metadataType}:${storedMember.metadataName} is malformed.`
                );
            }

            await metadataStore.addMember(storedMember);
            continue;
        }

        if (!storedMember.artifactId) {
            reject(
                SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_MISSING,
                `MODIFIED member ${storedMember.metadataType}:${storedMember.metadataName} is missing artifactId.`
            );
        }

        assertSafeSnapshotArtifactId(storedMember.artifactId, snapshotId.trim());

        const artifactEntry = artifacts[storedMember.artifactId];

        if (!isPlainObject(artifactEntry)) {
            reject(
                SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE.ARTIFACT_MISSING,
                `Artifact is not supplied for ${storedMember.artifactId}.`
            );
        }

        const bytes = decodeArtifactBase64(artifactEntry.contentBase64, {
            artifactId: storedMember.artifactId,
            expectedSize: artifactEntry.size
        });

        await blobStore.putArtifact({
            artifactId: storedMember.artifactId,
            bytes
        });

        await metadataStore.addMember(storedMember);
    }

    if (exportWasSealed) {
        await metadataStore.sealSnapshot(snapshotId.trim(), {
            sealedAt: snapshotExport.sealedAt ?? null,
            rollbackEligible: snapshotExport.rollbackEligible === true,
            overallIntegrityHash: snapshotExport.overallIntegrityHash ?? null,
            completedAt: snapshotExport.completedAt ?? null,
            memberCount:
                snapshotExport.memberCount !== undefined &&
                snapshotExport.memberCount !== null
                    ? snapshotExport.memberCount
                    : members.length
        });
    }

    return {
        captureService,
        snapshotId: snapshotId.trim(),
        metadataStore,
        blobStore
    };
}

module.exports = {
    SALESFORCE_ROLLBACK_SNAPSHOT_CONTEXT_CODE,
    SalesforceRollbackSnapshotContextError,
    createSalesforceRollbackSnapshotContext,
    normalizeCaptureStatus
};
