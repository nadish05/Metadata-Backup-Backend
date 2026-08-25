'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const unlink = util.promisify(fs.unlink);
const rename = util.promisify(fs.rename);
const stat = util.promisify(fs.stat);

function assertSafeStorageKey(value, label = 'id') {
    if (!value || typeof value !== 'string') {
        throw new TypeError(`${label} is required.`);
    }

    if (
        value.includes('..') ||
        value.includes('/') ||
        value.includes('\\') ||
        !/^[A-Za-z0-9._-]+$/.test(value)
    ) {
        throw new TypeError(`${label} is not a safe storage key.`);
    }

    return value;
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

function pathExistsSync(targetPath) {
    try {
        fs.statSync(targetPath);
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

function atomicWriteSync(filePath, contents, { exclusive = false } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        fs.writeFileSync(tempPath, contents);

        if (exclusive) {
            fs.writeFileSync(filePath, contents, { flag: 'wx' });
            fs.unlinkSync(tempPath);
            return;
        }

        if (pathExistsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        fs.renameSync(tempPath, filePath);
    } catch (error) {
        try {
            fs.unlinkSync(tempPath);
        } catch (cleanupError) {
            void cleanupError;
        }

        throw error;
    }
}

module.exports = {
    assertSafeStorageKey,
    pathExists,
    pathExistsSync,
    atomicWrite,
    atomicWriteSync
};
