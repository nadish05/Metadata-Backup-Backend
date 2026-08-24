'use strict';

/**
 * Deterministic snapshot artifact packing for one logical metadata member.
 *
 * Format SNAPMEM1 (binary, no XML rewrite, no line-ending normalization):
 *   magic        ASCII "SNAPMEM1\n"
 *   fileCount    uint32 BE
 *   repeating:
 *     pathLength   uint32 BE
 *     path         UTF-8 (POSIX relative path)
 *     contentLength uint32 BE
 *     content      exact retrieved bytes
 *
 * Files are ordered by relativePath using localeCompare('en').
 */

const MAGIC = Buffer.from('SNAPMEM1\n', 'utf8');

function normalizeRelativePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function toBuffer(bytes) {
    if (Buffer.isBuffer(bytes)) {
        return bytes;
    }

    if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes);
    }

    throw new TypeError('Member file bytes must be a Buffer or Uint8Array.');
}

function packMemberFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error('Cannot pack an empty destination-before file set.');
    }

    const sorted = [...files]
        .map((file) => ({
            relativePath: normalizeRelativePath(file.relativePath),
            bytes: toBuffer(file.bytes)
        }))
        .sort((left, right) =>
            left.relativePath.localeCompare(right.relativePath, 'en')
        );

    const parts = [MAGIC];
    const count = Buffer.alloc(4);
    count.writeUInt32BE(sorted.length, 0);
    parts.push(count);

    for (const file of sorted) {
        const pathBuf = Buffer.from(file.relativePath, 'utf8');
        const pathLength = Buffer.alloc(4);
        pathLength.writeUInt32BE(pathBuf.length, 0);
        const contentLength = Buffer.alloc(4);
        contentLength.writeUInt32BE(file.bytes.length, 0);
        parts.push(pathLength, pathBuf, contentLength, file.bytes);
    }

    return Buffer.concat(parts);
}

function unpackMemberFiles(artifactBytes) {
    const bytes = toBuffer(artifactBytes);

    if (
        bytes.length < MAGIC.length + 4 ||
        !bytes.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
        throw new Error('Artifact is not a SNAPMEM1 member pack.');
    }

    let offset = MAGIC.length;
    const fileCount = bytes.readUInt32BE(offset);
    offset += 4;
    const files = [];

    for (let i = 0; i < fileCount; i += 1) {
        const pathLength = bytes.readUInt32BE(offset);
        offset += 4;
        const relativePath = bytes.subarray(offset, offset + pathLength).toString('utf8');
        offset += pathLength;
        const contentLength = bytes.readUInt32BE(offset);
        offset += 4;
        const content = Buffer.from(bytes.subarray(offset, offset + contentLength));
        offset += contentLength;
        files.push({ relativePath, bytes: content });
    }

    return files;
}

module.exports = {
    MAGIC,
    packMemberFiles,
    unpackMemberFiles,
    normalizeRelativePath
};
