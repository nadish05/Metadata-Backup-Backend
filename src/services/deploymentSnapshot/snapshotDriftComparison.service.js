'use strict';

/**
 * Read-only hash comparison for future rollback drift checks.
 * Does not retrieve, deploy, restore, or mutate snapshots.
 */

const DRIFT_CLASSIFICATION = Object.freeze({
    UNCHANGED_FROM_BEFORE: 'UNCHANGED_FROM_BEFORE',
    MATCHES_EXPECTED_AFTER: 'MATCHES_EXPECTED_AFTER',
    CHANGED_FROM_BEFORE: 'CHANGED_FROM_BEFORE',
    DRIFTED: 'DRIFTED',
    UNKNOWN: 'UNKNOWN'
});

const DELETE_DRIFT_CLASSIFICATION = Object.freeze({
    MATCHES_EXPECTED_AFTER: DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER,
    DRIFTED: DRIFT_CLASSIFICATION.DRIFTED,
    MISSING_EXPECTED_AFTER: 'MISSING_EXPECTED_AFTER',
    UNKNOWN: DRIFT_CLASSIFICATION.UNKNOWN
});

function isUsableHash(value) {
    return typeof value === 'string' && value.length > 0;
}

function compareDestinationToSnapshot({
    destinationBeforeHash,
    expectedAfterHash,
    currentDestinationHash
} = {}) {
    const hasA = isUsableHash(destinationBeforeHash);
    const hasB = isUsableHash(expectedAfterHash);
    const hasC = isUsableHash(currentDestinationHash);

    if (!hasC || !hasA) {
        return {
            classification: DRIFT_CLASSIFICATION.UNKNOWN,
            expectedAfterAvailable: hasB,
            postDeploymentDriftClaimed: false
        };
    }

    if (hasB && currentDestinationHash === expectedAfterHash) {
        return {
            classification: DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER,
            expectedAfterAvailable: true,
            postDeploymentDriftClaimed: false
        };
    }

    if (currentDestinationHash === destinationBeforeHash) {
        return {
            classification: DRIFT_CLASSIFICATION.UNCHANGED_FROM_BEFORE,
            expectedAfterAvailable: hasB,
            postDeploymentDriftClaimed: false
        };
    }

    if (!hasB) {
        return {
            classification: DRIFT_CLASSIFICATION.CHANGED_FROM_BEFORE,
            expectedAfterAvailable: false,
            postDeploymentDriftClaimed: false
        };
    }

    return {
        classification: DRIFT_CLASSIFICATION.DRIFTED,
        expectedAfterAvailable: true,
        postDeploymentDriftClaimed: true
    };
}

function compareNewMemberForDeleteRollback({
    expectedAfterHash,
    currentDestinationHash
} = {}) {
    const hasB = isUsableHash(expectedAfterHash);
    const hasC = isUsableHash(currentDestinationHash);

    if (!hasB) {
        return {
            classification: DELETE_DRIFT_CLASSIFICATION.MISSING_EXPECTED_AFTER,
            expectedAfterAvailable: false
        };
    }

    if (!hasC) {
        return {
            classification: DELETE_DRIFT_CLASSIFICATION.UNKNOWN,
            expectedAfterAvailable: true
        };
    }

    if (currentDestinationHash === expectedAfterHash) {
        return {
            classification: DELETE_DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER,
            expectedAfterAvailable: true
        };
    }

    return {
        classification: DELETE_DRIFT_CLASSIFICATION.DRIFTED,
        expectedAfterAvailable: true
    };
}

module.exports = {
    DRIFT_CLASSIFICATION,
    DELETE_DRIFT_CLASSIFICATION,
    compareDestinationToSnapshot,
    compareNewMemberForDeleteRollback
};
