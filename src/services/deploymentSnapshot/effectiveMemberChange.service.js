'use strict';

const { hashBytes } = require('./snapshotIntegrity.service');
const {
    CANONICAL_EXPECTED_AFTER_TYPES,
    EXPECTED_AFTER_REPRESENTATION
} = require('./snapshot.types');
const {
    CANONICALIZATION_VERSION,
    canonicalizeForRollback
} = require('./rollbackMetadataCanonicalizer.service');

const EXISTING_MEMBER_CHANGE = Object.freeze({
    UNCHANGED: 'UNCHANGED',
    MODIFIED: 'MODIFIED',
    UNKNOWN: 'UNKNOWN'
});

const CANONICAL_ELIGIBLE_TYPES = new Set(CANONICAL_EXPECTED_AFTER_TYPES);

function isUsableHash(value) {
    return typeof value === 'string' && value.length > 0;
}

function hasArtifactBytes(bytes) {
    return bytes && bytes.length > 0;
}

function classifyCanonicalEligibleMember({
    metadataType,
    metadataName,
    filePath,
    destinationBeforeArtifactBytes,
    canonicalExpectedAfterHash
}) {
    if (!isUsableHash(canonicalExpectedAfterHash)) {
        return {
            classification: EXISTING_MEMBER_CHANGE.UNKNOWN,
            detail: 'canonical expected-after hash is missing.'
        };
    }

    try {
        const canonical = canonicalizeForRollback({
            metadataType,
            metadataName,
            filePath,
            artifactBytes: destinationBeforeArtifactBytes,
            canonicalizationVersion: CANONICALIZATION_VERSION
        });

        if (canonical.canonicalHash === canonicalExpectedAfterHash) {
            return { classification: EXISTING_MEMBER_CHANGE.UNCHANGED };
        }

        return { classification: EXISTING_MEMBER_CHANGE.MODIFIED };
    } catch (error) {
        return {
            classification: EXISTING_MEMBER_CHANGE.UNKNOWN,
            detail: 'effective change canonical comparison failed.'
        };
    }
}

/**
 * Classify whether an inventory-EXISTS member actually changes relative to
 * the deployment workspace artifact (pre-deploy destination retrieve vs expected-after).
 */
function classifyExistingMemberChange({
    metadataType,
    metadataName,
    filePath,
    destinationBeforeArtifactBytes,
    expectedAfterArtifactBytes,
    expectedAfterHash,
    canonicalExpectedAfterHash,
    expectedAfterRepresentation
} = {}) {
    if (!hasArtifactBytes(destinationBeforeArtifactBytes)) {
        return {
            classification: EXISTING_MEMBER_CHANGE.UNKNOWN,
            detail: 'destination-before artifact is missing.'
        };
    }

    if (!hasArtifactBytes(expectedAfterArtifactBytes)) {
        return {
            classification: EXISTING_MEMBER_CHANGE.UNKNOWN,
            detail: 'expected-after artifact is missing.'
        };
    }

    if (!isUsableHash(expectedAfterHash)) {
        return {
            classification: EXISTING_MEMBER_CHANGE.UNKNOWN,
            detail: 'expected-after hash is missing.'
        };
    }

    const destinationBeforeHash = hashBytes(destinationBeforeArtifactBytes);

    if (destinationBeforeHash === expectedAfterHash) {
        return { classification: EXISTING_MEMBER_CHANGE.UNCHANGED };
    }

    if (!CANONICAL_ELIGIBLE_TYPES.has(metadataType)) {
        return { classification: EXISTING_MEMBER_CHANGE.MODIFIED };
    }

    if (
        expectedAfterRepresentation &&
        expectedAfterRepresentation !== EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1 &&
        expectedAfterRepresentation !== EXPECTED_AFTER_REPRESENTATION.RAW
    ) {
        return {
            classification: EXISTING_MEMBER_CHANGE.UNKNOWN,
            detail: 'expected-after representation is ambiguous.'
        };
    }

    return classifyCanonicalEligibleMember({
        metadataType,
        metadataName,
        filePath,
        destinationBeforeArtifactBytes,
        canonicalExpectedAfterHash
    });
}

module.exports = {
    EXISTING_MEMBER_CHANGE,
    classifyExistingMemberChange
};
