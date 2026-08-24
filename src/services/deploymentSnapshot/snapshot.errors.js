'use strict';

class SnapshotError extends Error {
    constructor(message, code = 'SNAPSHOT_ERROR') {
        super(message);
        this.name = 'SnapshotError';
        this.code = code;
    }
}

class SnapshotValidationError extends SnapshotError {
    constructor(message) {
        super(message, 'SNAPSHOT_VALIDATION_ERROR');
        this.name = 'SnapshotValidationError';
    }
}

class SnapshotNotFoundError extends SnapshotError {
    constructor(snapshotId) {
        super(`Snapshot not found: ${snapshotId}`, 'SNAPSHOT_NOT_FOUND');
        this.name = 'SnapshotNotFoundError';
        this.snapshotId = snapshotId;
    }
}

class SnapshotAlreadySealedError extends SnapshotError {
    constructor(snapshotId) {
        super(
            `Snapshot is SEALED and immutable: ${snapshotId}`,
            'SNAPSHOT_ALREADY_SEALED'
        );
        this.name = 'SnapshotAlreadySealedError';
        this.snapshotId = snapshotId;
    }
}

class SnapshotIntegrityError extends SnapshotError {
    constructor(message) {
        super(message, 'SNAPSHOT_INTEGRITY_ERROR');
        this.name = 'SnapshotIntegrityError';
    }
}

class SnapshotMemberConflictError extends SnapshotError {
    constructor(message) {
        super(message, 'SNAPSHOT_MEMBER_CONFLICT');
        this.name = 'SnapshotMemberConflictError';
    }
}

class SnapshotStateError extends SnapshotError {
    constructor(message) {
        super(message, 'SNAPSHOT_STATE_ERROR');
        this.name = 'SnapshotStateError';
    }
}

module.exports = {
    SnapshotError,
    SnapshotValidationError,
    SnapshotNotFoundError,
    SnapshotAlreadySealedError,
    SnapshotIntegrityError,
    SnapshotMemberConflictError,
    SnapshotStateError
};
