'use strict';

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');
const { toNodeCaptureStatus, toSalesforceCaptureStatus } = require('./controlPlane.captureStatus');
const { toSalesforceMemberKey } = require('./controlPlane.memberKey');
const { sfField, toBoolean, toIso, toNumber, toText } = require('./controlPlane.record');

const SNAPSHOT_WRITE_FIELDS = Object.freeze([
    'snapshotId',
    'deploymentId',
    'sourceOrgId',
    'destinationOrgId',
    'sourceBranch',
    'destinationBranch',
    'createdAt',
    'completedAt',
    'status',
    'schemaVersion',
    'snapshotVersion',
    'overallIntegrityHash',
    'rollbackEligible',
    'captureFailureReason',
    'memberCount'
]);

const SEAL_PATCH_FIELDS = Object.freeze([
    'completedAt',
    'overallIntegrityHash',
    'rollbackEligible',
    'schemaVersion',
    'snapshotVersion',
    'captureFailureReason',
    'memberCount'
]);

const SEAL_ACKNOWLEDGED_FIELDS = Object.freeze([
    ...SEAL_PATCH_FIELDS,
    'sealedAt',
    'status'
]);

function toSalesforceSnapshotPayload(snapshot, { includeSnapshotId = false } = {}) {
    const payload = {};

    if (includeSnapshotId && snapshot.snapshotId) {
        payload.snapshotId = snapshot.snapshotId;
    }

    for (const field of SNAPSHOT_WRITE_FIELDS) {
        if (field === 'snapshotId') {
            continue;
        }

        if (!Object.prototype.hasOwnProperty.call(snapshot, field)) {
            continue;
        }

        if (field === 'status' && snapshot.status === 'SEALED') {
            continue;
        }

        payload[field] = snapshot[field];
    }

    return payload;
}

function fromSalesforceSnapshot(record) {
    if (!record || typeof record !== 'object') {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_INVALID_RESPONSE,
            'Snapshot record is missing.'
        );
    }

    return {
        snapshotId: toText(sfField(record, 'Snapshot_Id__c', 'snapshotId')),
        deploymentId: toText(sfField(record, 'Deployment_Id__c', 'deploymentId')),
        sourceOrgId: toText(sfField(record, 'Source_Org_Id__c', 'sourceOrgId')),
        destinationOrgId: toText(sfField(record, 'Destination_Org_Id__c', 'destinationOrgId')),
        sourceBranch: toText(sfField(record, 'Source_Branch__c', 'sourceBranch')),
        destinationBranch: toText(
            sfField(record, 'Destination_Branch__c', 'destinationBranch')
        ),
        createdAt: toIso(sfField(record, 'Created_At__c', 'createdAt')),
        completedAt: toIso(sfField(record, 'Completed_At__c', 'completedAt')),
        sealedAt: toIso(sfField(record, 'Sealed_At__c', 'sealedAt')),
        status: toText(sfField(record, 'Status__c', 'status')),
        schemaVersion: toNumber(sfField(record, 'Schema_Version__c', 'schemaVersion')),
        snapshotVersion: toNumber(sfField(record, 'Snapshot_Version__c', 'snapshotVersion')),
        overallIntegrityHash: toText(
            sfField(record, 'Overall_Integrity_Hash__c', 'overallIntegrityHash')
        ),
        rollbackEligible: toBoolean(
            sfField(record, 'Rollback_Eligible__c', 'rollbackEligible'),
            false
        ),
        captureFailureReason: toText(
            sfField(record, 'Capture_Failure_Reason__c', 'captureFailureReason')
        ),
        memberCount: toNumber(sfField(record, 'Member_Count__c', 'memberCount'), 0)
    };
}

function toSalesforceMemberPayload(member) {
    if (Object.prototype.hasOwnProperty.call(member, 'captureFailureReason')) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            'Capture_Failure_Reason__c belongs only to Deployment_Snapshot__c, not members.'
        );
    }

    return {
        metadataType: member.metadataType,
        metadataName: member.metadataName,
        filePath: member.filePath || null,
        changeClass: member.changeClass,
        existedBefore: member.existedBefore,
        destinationBeforeHash: member.destinationBeforeHash || null,
        expectedAfterHash: member.expectedAfterHash || null,
        artifactId: member.artifactId || null,
        artifactSize: member.artifactSize == null ? null : member.artifactSize,
        captureStatus: toSalesforceCaptureStatus(member.captureStatus),
        contentDocumentId: member.contentDocumentId || null,
        memberKey: toSalesforceMemberKey(
            member.snapshotId,
            member.metadataType,
            member.metadataName
        )
    };
}

function fromSalesforceMember(record, snapshotId) {
    if (!record || typeof record !== 'object') {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_INVALID_RESPONSE,
            'Snapshot member record is missing.'
        );
    }

    const metadataType = toText(sfField(record, 'Metadata_Type__c', 'metadataType'));
    const metadataName = toText(sfField(record, 'Metadata_Name__c', 'metadataName'));

    return {
        snapshotId:
            snapshotId ||
            toText(sfField(record, 'Snapshot_Id__c', 'snapshotId')),
        metadataType,
        metadataName,
        filePath: toText(sfField(record, 'File_Path__c', 'filePath')),
        changeClass: toText(sfField(record, 'Change_Class__c', 'changeClass')),
        existedBefore: toBoolean(sfField(record, 'Existed_Before__c', 'existedBefore'), null),
        destinationBeforeHash: toText(
            sfField(record, 'Destination_Before_Hash__c', 'destinationBeforeHash')
        ),
        expectedAfterHash: toText(
            sfField(record, 'Expected_After_Hash__c', 'expectedAfterHash')
        ),
        artifactId: toText(sfField(record, 'Artifact_Id__c', 'artifactId')),
        artifactSize: toNumber(sfField(record, 'Artifact_Size__c', 'artifactSize'), 0),
        captureStatus: toNodeCaptureStatus(
            sfField(record, 'Capture_Status__c', 'captureStatus')
        ),
        contentDocumentId: toText(
            sfField(record, 'Content_Document_Id__c', 'contentDocumentId')
        )
    };
}

function assertSealFieldsCompatible(sealFields = {}) {
    const unknown = Object.keys(sealFields).filter(
        (key) => !SEAL_ACKNOWLEDGED_FIELDS.includes(key)
    );

    if (unknown.length) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `Salesforce seal cannot accept sealFields: ${unknown.sort().join(', ')}.`
        );
    }

    if (
        Object.prototype.hasOwnProperty.call(sealFields, 'status') &&
        sealFields.status &&
        sealFields.status !== 'SEALED'
    ) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH,
            `Salesforce seal cannot accept status=${sealFields.status}.`
        );
    }
}

function toSalesforceSealPatch(sealFields = {}) {
    assertSealFieldsCompatible(sealFields);
    const payload = {};

    for (const field of SEAL_PATCH_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(sealFields, field)) {
            payload[field] = sealFields[field];
        }
    }

    return payload;
}

module.exports = {
    SEAL_ACKNOWLEDGED_FIELDS,
    SEAL_PATCH_FIELDS,
    assertSealFieldsCompatible,
    fromSalesforceMember,
    fromSalesforceSnapshot,
    toSalesforceMemberPayload,
    toSalesforceSealPatch,
    toSalesforceSnapshotPayload
};
