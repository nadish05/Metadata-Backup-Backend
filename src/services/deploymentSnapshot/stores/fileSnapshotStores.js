'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const { SNAPSHOT_STATUS, memberIdentityKey } = require('../snapshot.types');
const {
    SnapshotAlreadySealedError,
    SnapshotNotFoundError,
    SnapshotStateError,
    SnapshotMemberConflictError
} = require('../snapshot.errors');

const mkdir = util.promisify(fs.mkdir);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const readdir = util.promisify(fs.readdir);
const rename = util.promisify(fs.rename);
const stat = util.promisify(fs.stat);
const unlink = util.promisify(fs.unlink);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertSafeSnapshotId(snapshotId) {
    if (!snapshotId || typeof snapshotId !== 'string') {
        throw new SnapshotStateError('snapshotId is required.');
    }

    if (
        snapshotId.includes('..') ||
        snapshotId.includes('/') ||
        snapshotId.includes('\\') ||
        !/^[A-Za-z0-9._-]+$/.test(snapshotId)
    ) {
        throw new SnapshotStateError('snapshotId is not a safe storage key.');
    }
}

function assertSafeArtifactId(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
        throw new TypeError('artifactId is required.');
    }

    const posix = artifactId.replace(/\\/g, '/');

    if (
        posix.includes('..') ||
        path.isAbsolute(posix) ||
        !posix.startsWith('snapshots/')
    ) {
        throw new TypeError('artifactId must be a snapshots/ relative path.');
    }

    return posix;
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

async function atomicWrite(filePath, contents, { exclusive = false } = {}) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        await writeFile(tempPath, contents);

        if (exclusive) {
            await writeFile(filePath, contents, { flag: 'wx' });
            await unlink(tempPath);
            return;
        }

        if (await pathExists(filePath)) {
            await unlink(filePath);
        }

        await rename(tempPath, filePath);
    } catch (error) {
        try {
            await unlink(tempPath);
        } catch (cleanupError) {
            void cleanupError;
        }

        throw error;
    }
}

function createFileSnapshotStores({ rootDir } = {}) {
    if (!rootDir) {
        throw new SnapshotStateError(
            'SNAPSHOT_DURABLE_ROOT is required for filesystem snapshot storage.'
        );
    }

    const metadataRoot = path.join(rootDir, 'metadata');
    const artifactRoot = path.join(rootDir, 'artifacts');

    function snapshotDir(snapshotId) {
        assertSafeSnapshotId(snapshotId);
        return path.join(metadataRoot, snapshotId);
    }

    function snapshotFile(snapshotId) {
        return path.join(snapshotDir(snapshotId), 'snapshot.json');
    }

    function membersDir(snapshotId) {
        return path.join(snapshotDir(snapshotId), 'members');
    }

    function memberFile(snapshotId, metadataType, metadataName) {
        const key = encodeURIComponent(
            memberIdentityKey(metadataType, metadataName)
        );

        return path.join(membersDir(snapshotId), `${key}.json`);
    }

    function artifactFile(artifactId) {
        const posix = assertSafeArtifactId(artifactId);

        return path.join(artifactRoot, ...posix.split('/'));
    }

    function snapshotIdFromArtifactId(artifactId) {
        const posix = assertSafeArtifactId(artifactId);
        const parts = posix.split('/');

        return parts[1] || null;
    }

    async function readJson(filePath) {
        const raw = await readFile(filePath, 'utf8');

        return JSON.parse(raw);
    }

    async function loadSnapshotRecord(snapshotId) {
        const filePath = snapshotFile(snapshotId);

        if (!(await pathExists(filePath))) {
            return null;
        }

        return readJson(filePath);
    }

    async function requireSnapshotRecord(snapshotId) {
        const snapshot = await loadSnapshotRecord(snapshotId);

        if (!snapshot) {
            throw new SnapshotNotFoundError(snapshotId);
        }

        return snapshot;
    }

    function assertMutable(snapshot) {
        if (snapshot.status === SNAPSHOT_STATUS.SEALED) {
            throw new SnapshotAlreadySealedError(snapshot.snapshotId);
        }
    }

    async function createSnapshot(snapshot) {
        assertSafeSnapshotId(snapshot?.snapshotId);

        const filePath = snapshotFile(snapshot.snapshotId);

        if (await pathExists(filePath)) {
            throw new SnapshotStateError(
                `Snapshot already exists: ${snapshot.snapshotId}`
            );
        }

        const stored = clone(snapshot);

        try {
            await mkdir(membersDir(snapshot.snapshotId), { recursive: true });
            await atomicWrite(filePath, JSON.stringify(stored), {
                exclusive: true
            });
        } catch (error) {
            if (error && error.code === 'EEXIST') {
                throw new SnapshotStateError(
                    `Snapshot already exists: ${snapshot.snapshotId}`
                );
            }

            throw error;
        }

        return clone(stored);
    }

    async function getSnapshot(snapshotId) {
        assertSafeSnapshotId(snapshotId);
        const snapshot = await loadSnapshotRecord(snapshotId);

        return snapshot ? clone(snapshot) : null;
    }

    async function updateSnapshot(snapshotId, patch) {
        const snapshot = await requireSnapshotRecord(snapshotId);
        assertMutable(snapshot);
        Object.assign(snapshot, patch);
        await atomicWrite(snapshotFile(snapshotId), JSON.stringify(snapshot));

        return clone(snapshot);
    }

    async function addMember(member) {
        const snapshot = await requireSnapshotRecord(member.snapshotId);
        assertMutable(snapshot);

        const filePath = memberFile(
            member.snapshotId,
            member.metadataType,
            member.metadataName
        );

        if (await pathExists(filePath)) {
            throw new SnapshotMemberConflictError(
                `Snapshot member already exists for ${memberIdentityKey(
                    member.metadataType,
                    member.metadataName
                )}.`
            );
        }

        const stored = clone(member);

        try {
            await atomicWrite(filePath, JSON.stringify(stored), {
                exclusive: true
            });
        } catch (error) {
            if (error && error.code === 'EEXIST') {
                throw new SnapshotMemberConflictError(
                    `Snapshot member already exists for ${memberIdentityKey(
                        member.metadataType,
                        member.metadataName
                    )}.`
                );
            }

            throw error;
        }

        return clone(stored);
    }

    async function getMember(snapshotId, metadataType, metadataName) {
        await requireSnapshotRecord(snapshotId);
        const filePath = memberFile(snapshotId, metadataType, metadataName);

        if (!(await pathExists(filePath))) {
            return null;
        }

        return clone(await readJson(filePath));
    }

    async function getMembers(snapshotId) {
        await requireSnapshotRecord(snapshotId);
        const directory = membersDir(snapshotId);

        if (!(await pathExists(directory))) {
            return [];
        }

        const files = (await readdir(directory)).filter((name) =>
            name.endsWith('.json')
        );
        const members = [];

        for (const fileName of files) {
            members.push(
                clone(await readJson(path.join(directory, fileName)))
            );
        }

        return members;
    }

    async function sealSnapshot(snapshotId, sealFields = {}) {
        const snapshot = await requireSnapshotRecord(snapshotId);
        assertMutable(snapshot);
        Object.assign(snapshot, sealFields, {
            status: SNAPSHOT_STATUS.SEALED
        });
        await atomicWrite(snapshotFile(snapshotId), JSON.stringify(snapshot));

        return clone(snapshot);
    }

    async function putArtifact({ artifactId, bytes }) {
        const posix = assertSafeArtifactId(artifactId);
        const snapshotId = snapshotIdFromArtifactId(posix);

        if (snapshotId) {
            const snapshot = await loadSnapshotRecord(snapshotId);

            if (snapshot?.status === SNAPSHOT_STATUS.SEALED) {
                throw new SnapshotAlreadySealedError(snapshotId);
            }
        }

        const filePath = artifactFile(posix);

        if (await pathExists(filePath)) {
            if (snapshotId) {
                const snapshot = await loadSnapshotRecord(snapshotId);

                if (snapshot?.status === SNAPSHOT_STATUS.SEALED) {
                    throw new SnapshotAlreadySealedError(snapshotId);
                }
            }

            throw new SnapshotStateError(
                `Artifact already exists: ${artifactId}`
            );
        }

        const stored = Buffer.isBuffer(bytes)
            ? bytes
            : Buffer.from(bytes);

        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, stored);

        return {
            artifactId,
            size: stored.length
        };
    }

    async function getArtifact(artifactId) {
        const filePath = artifactFile(artifactId);

        if (!(await pathExists(filePath))) {
            return null;
        }

        return readFile(filePath);
    }

    async function exists(artifactId) {
        return pathExists(artifactFile(artifactId));
    }

    async function getMetadata(artifactId) {
        const filePath = artifactFile(artifactId);

        if (!(await pathExists(filePath))) {
            return null;
        }

        const fileStat = await stat(filePath);

        return {
            artifactId,
            size: fileStat.size
        };
    }

    const metadataStore = {
        createSnapshot,
        getSnapshot,
        updateSnapshot,
        addMember,
        getMember,
        getMembers,
        sealSnapshot
    };

    const blobStore = {
        putArtifact,
        getArtifact,
        exists,
        getMetadata
    };

    return {
        metadataStore,
        blobStore
    };
}

module.exports = {
    createFileSnapshotStores,
    assertSafeSnapshotId,
    assertSafeArtifactId
};
