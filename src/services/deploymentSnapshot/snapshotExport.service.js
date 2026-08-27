'use strict';

/**
 * P0-R7.14 Phase A — export sealed snapshots to Application Org Apex.
 * Metadata-first export; artifact bytes via separate binary endpoint.
 */

const { SNAPSHOT_STATUS } = require('./snapshot.types');
const { SnapshotNotFoundError } = require('./snapshot.errors');
const {
    SNAPSHOT_EXPORT_ERROR_CODE,
    SnapshotExportError
} = require('./snapshotExport.errors');
const { assertSafeSnapshotArtifactId } = require('./snapshotArtifactId.service');
const { getSharedSnapshotAccess } = require('./snapshotAccess.service');

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function sanitizeMemberForExport(member) {
    return {
        metadataType: member.metadataType,
        metadataName: member.metadataName,
        filePath: member.filePath ?? null,
        changeClass: member.changeClass,
        existedBefore: member.existedBefore ?? null,
        destinationBeforeHash: member.destinationBeforeHash ?? null,
        expectedAfterHash: member.expectedAfterHash ?? null,
        artifactId: member.artifactId ?? null,
        artifactSize: member.artifactSize ?? 0,
        captureStatus: member.captureStatus
    };
}

function sanitizeSnapshotForExport(snapshot, members) {
    return {
        snapshotId: snapshot.snapshotId,
        deploymentId: snapshot.deploymentId ?? null,
        sourceOrgId: snapshot.sourceOrgId ?? null,
        destinationOrgId: snapshot.destinationOrgId ?? null,
        sourceBranch: snapshot.sourceBranch ?? null,
        destinationBranch: snapshot.destinationBranch ?? null,
        status: snapshot.status,
        schemaVersion: snapshot.schemaVersion,
        snapshotVersion: snapshot.snapshotVersion,
        overallIntegrityHash: snapshot.overallIntegrityHash ?? null,
        rollbackEligible: snapshot.rollbackEligible === true,
        createdAt: snapshot.createdAt,
        completedAt: snapshot.completedAt ?? null,
        sealedAt: snapshot.sealedAt ?? null,
        memberCount:
            snapshot.memberCount !== undefined && snapshot.memberCount !== null
                ? snapshot.memberCount
                : members.length,
        members: members.map(sanitizeMemberForExport)
    };
}

function createSnapshotExportService(dependencies = {}) {
    const resolveAccess =
        dependencies.getSharedSnapshotAccess || getSharedSnapshotAccess;

    async function loadSnapshot(snapshotId) {
        if (!isNonEmptyString(snapshotId)) {
            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST,
                'snapshotId is required.'
            );
        }

        const access = resolveAccess();

        let snapshot;

        try {
            snapshot = await access.getSnapshot(snapshotId.trim());
        } catch (error) {
            if (error instanceof SnapshotNotFoundError) {
                throw new SnapshotExportError(
                    SNAPSHOT_EXPORT_ERROR_CODE.NOT_FOUND,
                    `Snapshot not found: ${snapshotId.trim()}.`
                );
            }

            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.SNAPSHOT_UNAVAILABLE,
                'Snapshot is unavailable.'
            );
        }

        const members = await access.getMembers(snapshotId.trim());

        return { snapshot, members, access };
    }

    async function buildSnapshotExport(snapshotId) {
        const { snapshot, members } = await loadSnapshot(snapshotId);

        if (snapshot.status !== SNAPSHOT_STATUS.SEALED) {
            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.SNAPSHOT_UNAVAILABLE,
                `Snapshot export requires SEALED status (status=${snapshot.status}).`
            );
        }

        return sanitizeSnapshotForExport(snapshot, members);
    }

    function assertHistoryCorrelation(snapshot, historyId) {
        if (!isNonEmptyString(historyId)) {
            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST,
                'historyId is required.'
            );
        }

        if (
            snapshot.deploymentId &&
            snapshot.deploymentId !== historyId.trim()
        ) {
            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.NOT_FOUND,
                'Snapshot does not belong to this deployment history.'
            );
        }
    }

    async function retrieveSnapshotArtifact({
        snapshotId,
        artifactId,
        historyId
    }) {
        if (!isNonEmptyString(snapshotId)) {
            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST,
                'snapshotId is required.'
            );
        }

        assertSafeSnapshotArtifactId(artifactId, snapshotId.trim());

        const { snapshot, access } = await loadSnapshot(snapshotId.trim());
        assertHistoryCorrelation(snapshot, historyId);

        if (snapshot.status !== SNAPSHOT_STATUS.SEALED) {
            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.ARTIFACT_NOT_FOUND,
                'Artifact is not available for export.'
            );
        }

        let bytes;

        try {
            bytes = await access.getArtifact(snapshotId.trim(), artifactId);
        } catch (error) {
            if (
                error instanceof SnapshotNotFoundError ||
                (error && error.message && /not part of snapshot/i.test(error.message))
            ) {
                throw new SnapshotExportError(
                    SNAPSHOT_EXPORT_ERROR_CODE.ARTIFACT_NOT_FOUND,
                    'Artifact was not found for this snapshot.'
                );
            }

            throw error;
        }

        if (!bytes || !bytes.length) {
            throw new SnapshotExportError(
                SNAPSHOT_EXPORT_ERROR_CODE.ARTIFACT_NOT_FOUND,
                'Artifact was not found for this snapshot.'
            );
        }

        return Buffer.from(bytes);
    }

    async function maybeAttachSnapshotExport(response, snapshot, options = {}) {
        if (!response || typeof response !== 'object' || !snapshot?.snapshotId) {
            return response;
        }

        const exporter = options.exportService || defaultService;

        try {
            response.snapshotExport = await exporter.buildSnapshotExport(
                snapshot.snapshotId
            );
        } catch (error) {
            if (error instanceof SnapshotExportError) {
                response.snapshotExportError = {
                    code: error.code,
                    message: error.message
                };
            } else {
                response.snapshotExportError = {
                    code: SNAPSHOT_EXPORT_ERROR_CODE.SNAPSHOT_UNAVAILABLE,
                    message: 'Snapshot export is unavailable.'
                };
            }
        }

        return response;
    }

    return {
        buildSnapshotExport,
        retrieveSnapshotArtifact,
        maybeAttachSnapshotExport,
        sanitizeSnapshotForExport,
        sanitizeMemberForExport
    };
}

const defaultService = createSnapshotExportService();

module.exports = {
    createSnapshotExportService,
    buildSnapshotExport: defaultService.buildSnapshotExport,
    retrieveSnapshotArtifact: defaultService.retrieveSnapshotArtifact,
    maybeAttachSnapshotExport: defaultService.maybeAttachSnapshotExport,
    sanitizeSnapshotForExport: defaultService.sanitizeSnapshotForExport,
    sanitizeMemberForExport: defaultService.sanitizeMemberForExport
};
