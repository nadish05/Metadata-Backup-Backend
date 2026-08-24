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
 * Rule (documented + tested):
 * 1. Sort members by metadataType, then metadataName (UTF-16 code unit order,
 *    which is JavaScript String.prototype.localeCompare default via <).
 *    Implementation uses localeCompare with sensitivity: 'variant' on both
 *    fields for a stable lexicographic order independent of insertion.
 * 2. For each member emit one line:
 *      metadataType + '\t' + metadataName + '\t' + changeClass + '\t' + token
 *    where token is destinationBeforeHash for MODIFIED, or the literal
 *    'ABSENT' when there is no destination-before artifact (NEW / UNKNOWN).
 * 3. Join lines with '\n' (no trailing newline if empty).
 * 4. SHA-256 the UTF-8 bytes of that document.
 *
 * Insertion order of members MUST NOT affect the result.
 */
function computeSnapshotIntegrityHash(members) {
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
        const token =
            member.changeClass === CHANGE_CLASS.MODIFIED &&
            member.destinationBeforeHash
                ? member.destinationBeforeHash
                : 'ABSENT';

        return [
            member.metadataType,
            member.metadataName,
            member.changeClass,
            token
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
