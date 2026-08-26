'use strict';

const { CONTROL_PLANE_ERROR_CODE, ControlPlaneError } = require('../controlPlane.errors');
const { createAuthUnavailableError } = require('../controlPlane.auth');
const {
    fromSalesforceMember,
    fromSalesforceSnapshot,
    toSalesforceMemberPayload,
    toSalesforceSealPatch,
    toSalesforceSnapshotPayload
} = require('../controlPlane.snapshotMapping');

function resolveClient(options = {}) {
    if (options.client) {
        return options.client;
    }

    if (typeof options.getClient === 'function') {
        return options.getClient();
    }

    throw createAuthUnavailableError();
}

function encodePath(value) {
    return encodeURIComponent(String(value));
}

function mapSnapshotError(error, snapshotId) {
    if (
        error instanceof ControlPlaneError &&
        error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
    ) {
        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND,
            `Snapshot not found: ${snapshotId}`,
            { salesforceCode: error.salesforceCode, field: error.field }
        );
    }

    return error;
}

function createSalesforceControlPlaneSnapshotMetadataStore(options = {}) {
    async function createSnapshot(snapshot) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane('POST', '/snapshots', {
                body: toSalesforceSnapshotPayload(snapshot, {
                    includeSnapshotId: true
                })
            });

            return fromSalesforceSnapshot(envelope.record);
        } catch (error) {
            throw mapSnapshotError(error, snapshot?.snapshotId);
        }
    }

    async function getSnapshot(snapshotId) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'GET',
                `/snapshots/${encodePath(snapshotId)}`
            );

            return fromSalesforceSnapshot(envelope.record);
        } catch (error) {
            if (
                error instanceof ControlPlaneError &&
                error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND
            ) {
                return null;
            }

            throw mapSnapshotError(error, snapshotId);
        }
    }

    async function updateSnapshot(snapshotId, patch) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'PATCH',
                `/snapshots/${encodePath(snapshotId)}`,
                { body: toSalesforceSnapshotPayload(patch) }
            );

            return fromSalesforceSnapshot(envelope.record);
        } catch (error) {
            throw mapSnapshotError(error, snapshotId);
        }
    }

    async function addMember(member) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'POST',
                `/snapshots/${encodePath(member.snapshotId)}/members`,
                { body: toSalesforceMemberPayload(member) }
            );
            const stored = fromSalesforceMember(envelope.record, member.snapshotId);

            return {
                ...stored,
                snapshotId: member.snapshotId
            };
        } catch (error) {
            throw mapSnapshotError(error, member?.snapshotId);
        }
    }

    async function getMembers(snapshotId) {
        const client = resolveClient(options);

        try {
            const envelope = await client.controlPlane(
                'GET',
                `/snapshots/${encodePath(snapshotId)}/members`
            );
            const records = Array.isArray(envelope.records) ? envelope.records : [];

            return records.map((record) =>
                fromSalesforceMember(record, snapshotId)
            );
        } catch (error) {
            throw mapSnapshotError(error, snapshotId);
        }
    }

    async function getMember(snapshotId, metadataType, metadataName) {
        const members = await getMembers(snapshotId);
        const found = members.find(
            (member) =>
                member.metadataType === metadataType &&
                member.metadataName === metadataName
        );

        if (found) {
            return found;
        }

        return null;
    }

    async function sealSnapshot(snapshotId, sealFields = {}) {
        const client = resolveClient(options);
        const patch = toSalesforceSealPatch(sealFields);

        try {
            if (Object.keys(patch).length) {
                await client.controlPlane(
                    'PATCH',
                    `/snapshots/${encodePath(snapshotId)}`,
                    { body: patch }
                );
            }

            const envelope = await client.controlPlane(
                'POST',
                `/snapshots/${encodePath(snapshotId)}/seal`
            );

            return fromSalesforceSnapshot(envelope.record);
        } catch (error) {
            throw mapSnapshotError(error, snapshotId);
        }
    }

    return {
        createSnapshot,
        getSnapshot,
        updateSnapshot,
        addMember,
        getMember,
        getMembers,
        sealSnapshot
    };
}

module.exports = {
    createSalesforceControlPlaneSnapshotMetadataStore
};
