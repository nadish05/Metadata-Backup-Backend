'use strict';

const { LOCK_STATUS } = require('../deploymentOrgLock/deploymentOrgLock.types');
const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('./controlPlane.errors');
const { sfField, toIso, toNumber, toText } = require('./controlPlane.record');

function toSalesforceLockAcquirePayload(args = {}) {
    return {
        destinationOrgId: args.destinationOrgId,
        ownerId: args.ownerId,
        operationType: args.operationType,
        expiresAt: args.expiresAt || null,
        historyId: args.historyId || null,
        snapshotId: args.snapshotId || null
    };
}

function toSalesforceLockOwnershipPayload(args = {}) {
    return {
        destinationOrgId: args.destinationOrgId,
        ownerId: args.ownerId,
        leaseGeneration: args.leaseGeneration,
        expiresAt: args.expiresAt || null
    };
}

function fromSalesforceLock(record, leaseGeneration) {
    if (!record || typeof record !== 'object') {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_INVALID_RESPONSE,
            'Destination org lock record is missing.'
        );
    }

    const status = toText(sfField(record, 'Status__c', 'status')) || LOCK_STATUS.RELEASED;

    return {
        lockId: toText(sfField(record, 'Id', 'lockId', 'id')),
        destinationOrgId: toText(
            sfField(record, 'Destination_Org_Id__c', 'destinationOrgId')
        ),
        ownerId: toText(sfField(record, 'Owner_Id__c', 'ownerId')),
        leaseGeneration: toNumber(
            leaseGeneration != null
                ? leaseGeneration
                : sfField(record, 'Lease_Generation__c', 'leaseGeneration'),
            0
        ),
        status,
        operationType: toText(sfField(record, 'Operation_Type__c', 'operationType')),
        acquiredAt: toIso(sfField(record, 'Acquired_At__c', 'acquiredAt')),
        expiresAt: toIso(sfField(record, 'Expires_At__c', 'expiresAt')),
        lastHeartbeatAt: toIso(
            sfField(record, 'Last_Heartbeat_At__c', 'lastHeartbeatAt')
        ),
        historyId: toText(sfField(record, 'History_Id__c', 'historyId')),
        snapshotId: toText(sfField(record, 'Snapshot_Id__c', 'snapshotId')),
        releasedAt: status === LOCK_STATUS.RELEASED
            ? toIso(sfField(record, 'Last_Heartbeat_At__c', 'releasedAt'))
            : null
    };
}

module.exports = {
    fromSalesforceLock,
    toSalesforceLockAcquirePayload,
    toSalesforceLockOwnershipPayload
};
