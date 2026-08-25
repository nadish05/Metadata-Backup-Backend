'use strict';

const crypto = require('crypto');

const { assertSafeStorageKey } = require('../../utils/durableFileStore');
const {
    RollbackOperationScopeAmbiguousError
} = require('./rollbackOperation.errors');
const { ROLLBACK_OPERATION_STATUS } = require('./rollbackOperation.types');

const ROLLBACK_SCOPE_SCHEMA_VERSION = 1;
const SCOPE_KEY_SEPARATOR = '::';

const KNOWN_STATUSES = new Set(Object.values(ROLLBACK_OPERATION_STATUS));

function buildRollbackScopeKey(destinationOrgId, snapshotId) {
    const dest = assertSafeStorageKey(destinationOrgId, 'destinationOrgId');
    const snap = assertSafeStorageKey(snapshotId, 'snapshotId');

    return `${dest}${SCOPE_KEY_SEPARATOR}${snap}`;
}

function parseRollbackScopeKey(rollbackScopeKey) {
    if (!rollbackScopeKey || typeof rollbackScopeKey !== 'string') {
        throw new TypeError('rollbackScopeKey is required.');
    }

    const separatorIndex = rollbackScopeKey.indexOf(SCOPE_KEY_SEPARATOR);

    if (separatorIndex <= 0) {
        throw new TypeError('rollbackScopeKey is invalid.');
    }

    const destinationOrgId = rollbackScopeKey.slice(0, separatorIndex);
    const snapshotId = rollbackScopeKey.slice(
        separatorIndex + SCOPE_KEY_SEPARATOR.length
    );

    return {
        destinationOrgId: assertSafeStorageKey(
            destinationOrgId,
            'destinationOrgId'
        ),
        snapshotId: assertSafeStorageKey(snapshotId, 'snapshotId')
    };
}

function rollbackScopeFileKey(rollbackScopeKey) {
    parseRollbackScopeKey(rollbackScopeKey);

    return crypto
        .createHash('sha256')
        .update(rollbackScopeKey, 'utf8')
        .digest('hex');
}

function deriveRollbackScopeKey(record) {
    if (!record) {
        return null;
    }

    if (record.rollbackScopeKey) {
        const parsed = parseRollbackScopeKey(record.rollbackScopeKey);
        const derived = buildRollbackScopeKey(
            record.destinationOrgId,
            record.snapshotId
        );

        if (
            parsed.destinationOrgId !== record.destinationOrgId ||
            parsed.snapshotId !== record.snapshotId ||
            record.rollbackScopeKey !== derived
        ) {
            throw new RollbackOperationScopeAmbiguousError(
                'Rollback operation scope key does not match destinationOrgId and snapshotId.'
            );
        }

        return derived;
    }

    return buildRollbackScopeKey(record.destinationOrgId, record.snapshotId);
}

function pickOldest(records) {
    return [...records].sort((left, right) => {
        const leftTime = Date.parse(left.createdAt || left.updatedAt || 0);
        const rightTime = Date.parse(right.createdAt || right.updatedAt || 0);

        if (leftTime !== rightTime) {
            return leftTime - rightTime;
        }

        return String(left.operationId || '').localeCompare(
            String(right.operationId || '')
        );
    })[0];
}

function pickNewestCreated(records) {
    return [...records].sort((left, right) => {
        const leftTime = Date.parse(left.createdAt || left.updatedAt || 0);
        const rightTime = Date.parse(right.createdAt || right.updatedAt || 0);

        if (leftTime !== rightTime) {
            return rightTime - leftTime;
        }

        return String(right.operationId || '').localeCompare(
            String(left.operationId || '')
        );
    })[0];
}

function evaluateExistingOperations(records) {
    const list = Array.isArray(records) ? records.filter(Boolean) : [];

    if (!list.length) {
        return { action: 'CREATE', existing: null };
    }

    for (const record of list) {
        if (!KNOWN_STATUSES.has(record.status)) {
            throw new RollbackOperationScopeAmbiguousError(
                'Rollback operation set contains an invalid or unreadable status.'
            );
        }

        try {
            deriveRollbackScopeKey(record);
        } catch (error) {
            if (error instanceof RollbackOperationScopeAmbiguousError) {
                throw error;
            }

            throw new RollbackOperationScopeAmbiguousError(
                'Rollback operation set contains an invalid destinationOrgId or snapshotId.'
            );
        }
    }

    const succeeded = list.filter(
        (record) => record.status === ROLLBACK_OPERATION_STATUS.SUCCEEDED
    );

    if (succeeded.length) {
        return {
            action: 'BLOCK_COMPLETED',
            existing: pickOldest(succeeded)
        };
    }

    const unknown = list.filter(
        (record) => record.status === ROLLBACK_OPERATION_STATUS.UNKNOWN_RESULT
    );

    if (unknown.length) {
        return {
            action: 'BLOCK_UNKNOWN',
            existing: pickOldest(unknown)
        };
    }

    const inProgress = list.filter(
        (record) => record.status === ROLLBACK_OPERATION_STATUS.IN_PROGRESS
    );

    if (inProgress.length) {
        return {
            action: 'BLOCK_IN_PROGRESS',
            existing: pickOldest(inProgress)
        };
    }

    const notStarted = list.filter(
        (record) => record.status === ROLLBACK_OPERATION_STATUS.NOT_STARTED
    );

    if (notStarted.length) {
        return {
            action: 'RESUME',
            existing: pickOldest(notStarted)
        };
    }

    const failed = list.filter(
        (record) => record.status === ROLLBACK_OPERATION_STATUS.FAILED
    );

    if (failed.length === list.length) {
        return {
            action: 'RETRY',
            existing: pickNewestCreated(failed)
        };
    }

    throw new RollbackOperationScopeAmbiguousError(
        'Rollback operation set could not be evaluated safely.'
    );
}

function evaluateExistingOperation(existing) {
    if (!existing) {
        return { action: 'CREATE', existing: null };
    }

    return evaluateExistingOperations([existing]);
}

module.exports = {
    ROLLBACK_SCOPE_SCHEMA_VERSION,
    SCOPE_KEY_SEPARATOR,
    buildRollbackScopeKey,
    deriveRollbackScopeKey,
    evaluateExistingOperation,
    evaluateExistingOperations,
    parseRollbackScopeKey,
    rollbackScopeFileKey
};
