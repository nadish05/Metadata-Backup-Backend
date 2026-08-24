'use strict';

const crypto = require('crypto');

const { CHANGE_CLASS } = require('./snapshot.types');

/**
 * SHA-256 of the exact captured bytes.
 * Does not normalize XML, line endings, or encoding.
 * Input must be a Buffer (or Uint8Array); strings are not hashed.
 */
function hashBytes(bytes) {
    if (!isBinary(bytes)) {
        throw new TypeError(
            'hashBytes requires a Buffer or Uint8Array of captured bytes.'
        );
    }

    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isBinary(value) {
    return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function toBuffer(bytes) {
    if (Buffer.isBuffer(bytes)) {
        return bytes;
    }

    if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes);
    }

    return null;
}

/**
 * Canonical aggregate snapshot hash.
 *
 * schemaVersion 1 (P0-R2):
 *   type \t name \t changeClass \t destinationBeforeHash|ABSENT
 *
 * schemaVersion 2 (P0-R5.1):
 *   type \t name \t changeClass \t destinationBeforeHash|ABSENT \t expectedAfterHash|ABSENT
 *
 * Members are sorted by metadataType then metadataName (localeCompare 'en').
 * Insertion order MUST NOT affect the result.
 * Default schemaVersion is 1 so existing P0-R2 hash documents remain stable.
 */
function computeSnapshotIntegrityHash(members, options = {}) {
    const schemaVersion = options.schemaVersion || 1;
    const list = Array.isArray(members) ? [...members] : [];

    list.sort((left, right) => {
        const typeCompare = String(left.metadataType || '').localeCompare(
            String(right.metadataType || ''),
            'en'
        );

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return String(left.metadataName || '').localeCompare(
            String(right.metadataName || ''),
            'en'
        );
    });

    const lines = list.map((member) => {
        const beforeToken =
            member.changeClass === CHANGE_CLASS.MODIFIED &&
            member.destinationBeforeHash
                ? member.destinationBeforeHash
                : 'ABSENT';

        if (schemaVersion >= 2) {
            const afterToken =
                member.changeClass === CHANGE_CLASS.MODIFIED &&
                member.expectedAfterHash
                    ? member.expectedAfterHash
                    : 'ABSENT';

            return [
                member.metadataType,
                member.metadataName,
                member.changeClass,
                beforeToken,
                afterToken
            ].join('\t');
        }

        return [
            member.metadataType,
            member.metadataName,
            member.changeClass,
            beforeToken
        ].join('\t');
    });

    const document = lines.join('\n');

    return crypto.createHash('sha256').update(document, 'utf8').digest('hex');
}

function hashesMatch(expected, actual) {
    return (
        typeof expected === 'string' &&
        typeof actual === 'string' &&
        expected.length > 0 &&
        expected === actual
    );
}

module.exports = {
    hashBytes,
    toBuffer,
    isBinary,
    computeSnapshotIntegrityHash,
    hashesMatch
};
