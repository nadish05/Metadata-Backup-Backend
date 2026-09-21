'use strict';

/**
 * Read-only hash comparison for future rollback drift checks.
 * Does not retrieve, deploy, restore, or mutate snapshots.
 */

const {
    EXPECTED_AFTER_REPRESENTATION
} = require('./snapshot.types');
const {
    CANONICALIZATION_VERSION,
    canonicalizeForRollback
} = require('./rollbackMetadataCanonicalizer.service');

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

function resolveExpectedAfterRepresentation(expectedAfterRepresentation) {
    if (
        expectedAfterRepresentation === undefined ||
        expectedAfterRepresentation === null ||
        expectedAfterRepresentation === EXPECTED_AFTER_REPRESENTATION.RAW
    ) {
        return EXPECTED_AFTER_REPRESENTATION.RAW;
    }

    if (
        expectedAfterRepresentation === EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
    ) {
        return EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1;
    }

    if (
        expectedAfterRepresentation ===
        EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1
    ) {
        return EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1;
    }

    return null;
}

function compareRecordTypeSemanticExpectedAfter({
    canonicalExpectedAfterHash,
    currentRecordTypeSemanticHash,
    recordTypeSemanticCaptureSpec,
    expectedAfterAvailable
} = {}) {
    const comparisonMode = EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1;

    if (!isUsableHash(canonicalExpectedAfterHash)) {
        return buildFailClosedResult({
            expectedAfterAvailable,
            comparisonMode,
            failClosedReason: 'MISSING_CANONICAL_EXPECTED_AFTER_HASH'
        });
    }

    if (
        !recordTypeSemanticCaptureSpec ||
        !Array.isArray(recordTypeSemanticCaptureSpec.picklistFieldApiNames) ||
        !recordTypeSemanticCaptureSpec.picklistFieldApiNames.length
    ) {
        return buildFailClosedResult({
            expectedAfterAvailable,
            comparisonMode,
            failClosedReason: 'MISSING_RECORDTYPE_SEMANTIC_CAPTURE_SPEC'
        });
    }

    if (!isUsableHash(currentRecordTypeSemanticHash)) {
        return buildFailClosedResult({
            expectedAfterAvailable,
            comparisonMode,
            failClosedReason: 'MISSING_DESTINATION_RECORDTYPE_SEMANTIC_HASH'
        });
    }

    if (currentRecordTypeSemanticHash === canonicalExpectedAfterHash) {
        return {
            classification: DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER,
            expectedAfterAvailable: expectedAfterAvailable === true,
            postDeploymentDriftClaimed: false,
            comparisonMode,
            failClosed: false
        };
    }

    return {
        classification: DRIFT_CLASSIFICATION.DRIFTED,
        expectedAfterAvailable: expectedAfterAvailable === true,
        postDeploymentDriftClaimed: true,
        comparisonMode,
        failClosed: false
    };
}

function buildFailClosedResult(base = {}) {
    return {
        classification: DRIFT_CLASSIFICATION.UNKNOWN,
        expectedAfterAvailable: base.expectedAfterAvailable === true,
        postDeploymentDriftClaimed: false,
        failClosed: true,
        comparisonMode: base.comparisonMode || null,
        failClosedReason: base.failClosedReason || 'UNKNOWN_REPRESENTATION'
    };
}

function canonicalizeDestinationHash({
    metadataType,
    metadataName,
    filePath,
    currentDestinationArtifactBytes
}) {
    const canonical = canonicalizeForRollback({
        metadataType,
        metadataName,
        filePath,
        artifactBytes: currentDestinationArtifactBytes,
        canonicalizationVersion: CANONICALIZATION_VERSION
    });

    return canonical.canonicalHash;
}

function compareCanonicalExpectedAfter({
    metadataType,
    metadataName,
    filePath,
    canonicalExpectedAfterHash,
    currentDestinationArtifactBytes,
    expectedAfterAvailable
}) {
    if (!isUsableHash(canonicalExpectedAfterHash)) {
        return buildFailClosedResult({
            expectedAfterAvailable,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            failClosedReason: 'MISSING_CANONICAL_EXPECTED_AFTER_HASH'
        });
    }

    if (!currentDestinationArtifactBytes || !currentDestinationArtifactBytes.length) {
        return buildFailClosedResult({
            expectedAfterAvailable,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            failClosedReason: 'MISSING_DESTINATION_ARTIFACT_BYTES'
        });
    }

    try {
        const currentCanonicalHash = canonicalizeDestinationHash({
            metadataType,
            metadataName,
            filePath,
            currentDestinationArtifactBytes
        });

        if (currentCanonicalHash === canonicalExpectedAfterHash) {
            return {
                classification: DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER,
                expectedAfterAvailable: true,
                postDeploymentDriftClaimed: false,
                comparisonMode: EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                failClosed: false
            };
        }

        return {
            classification: DRIFT_CLASSIFICATION.DRIFTED,
            expectedAfterAvailable: true,
            postDeploymentDriftClaimed: true,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            failClosed: false
        };
    } catch (error) {
        return buildFailClosedResult({
            expectedAfterAvailable,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            failClosedReason: 'CANONICALIZATION_FAILED'
        });
    }
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

function compareMemberExpectedAfterDrift({
    metadataType,
    metadataName,
    filePath,
    destinationBeforeHash,
    expectedAfterHash,
    canonicalExpectedAfterHash,
    expectedAfterRepresentation,
    currentDestinationHash,
    currentDestinationArtifactBytes,
    currentRecordTypeSemanticHash,
    recordTypeSemanticCaptureSpec,
    isDeleteRollback = false
} = {}) {
    const representation = resolveExpectedAfterRepresentation(
        expectedAfterRepresentation
    );

    if (!representation) {
        return buildFailClosedResult({
            expectedAfterAvailable: isUsableHash(expectedAfterHash),
            failClosedReason: 'UNKNOWN_REPRESENTATION'
        });
    }

    if (
        metadataType === 'RecordType' &&
        representation === EXPECTED_AFTER_REPRESENTATION.RECORDTYPE_SEMANTIC_V1
    ) {
        return compareRecordTypeSemanticExpectedAfter({
            canonicalExpectedAfterHash,
            currentRecordTypeSemanticHash,
            recordTypeSemanticCaptureSpec,
            expectedAfterAvailable: isUsableHash(expectedAfterHash)
        });
    }

    if (isDeleteRollback) {
        const rawResult = compareNewMemberForDeleteRollback({
            expectedAfterHash,
            currentDestinationHash
        });

        if (
            rawResult.classification ===
            DELETE_DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        ) {
            return {
                ...rawResult,
                comparisonMode: EXPECTED_AFTER_REPRESENTATION.RAW,
                failClosed: false
            };
        }

        if (representation === EXPECTED_AFTER_REPRESENTATION.RAW) {
            return {
                ...rawResult,
                comparisonMode: EXPECTED_AFTER_REPRESENTATION.RAW,
                failClosed: false
            };
        }

        const canonicalResult = compareCanonicalExpectedAfter({
            metadataType,
            metadataName,
            filePath,
            canonicalExpectedAfterHash,
            currentDestinationArtifactBytes,
            expectedAfterAvailable: rawResult.expectedAfterAvailable
        });

        if (
            canonicalResult.classification ===
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        ) {
            return canonicalResult;
        }

        if (canonicalResult.failClosed) {
            return canonicalResult;
        }

        return {
            classification: DELETE_DRIFT_CLASSIFICATION.DRIFTED,
            expectedAfterAvailable: true,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            failClosed: false
        };
    }

    const rawResult = compareDestinationToSnapshot({
        destinationBeforeHash,
        expectedAfterHash,
        currentDestinationHash
    });

    if (
        rawResult.classification === DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
    ) {
        return {
            ...rawResult,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.RAW,
            failClosed: false
        };
    }

    if (
        rawResult.classification === DRIFT_CLASSIFICATION.UNCHANGED_FROM_BEFORE
    ) {
        return {
            ...rawResult,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.RAW,
            failClosed: false
        };
    }

    if (representation === EXPECTED_AFTER_REPRESENTATION.RAW) {
        return {
            ...rawResult,
            comparisonMode: EXPECTED_AFTER_REPRESENTATION.RAW,
            failClosed: false
        };
    }

    const canonicalResult = compareCanonicalExpectedAfter({
        metadataType,
        metadataName,
        filePath,
        canonicalExpectedAfterHash,
        currentDestinationArtifactBytes,
        expectedAfterAvailable: rawResult.expectedAfterAvailable
    });

    if (canonicalResult.failClosed) {
        return canonicalResult;
    }

    if (
        canonicalResult.classification ===
        DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
    ) {
        return canonicalResult;
    }

    return {
        ...rawResult,
        comparisonMode: EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
        failClosed: false
    };
}

module.exports = {
    DRIFT_CLASSIFICATION,
    DELETE_DRIFT_CLASSIFICATION,
    EXPECTED_AFTER_REPRESENTATION,
    compareDestinationToSnapshot,
    compareNewMemberForDeleteRollback,
    compareMemberExpectedAfterDrift,
    compareRecordTypeSemanticExpectedAfter,
    resolveExpectedAfterRepresentation
};
