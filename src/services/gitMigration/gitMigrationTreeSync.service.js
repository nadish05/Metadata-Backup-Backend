'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);
const rm = util.promisify(fs.rm);
const mkdir = util.promisify(fs.mkdir);
const copyFile = util.promisify(fs.copyFile);

const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const { TREE_SYNC_DENYLIST } = require('./gitMigration.config');

function isDeniedName(name) {
    return TREE_SYNC_DENYLIST.includes(name);
}

async function assertSnapshotValid(snapshotRoot) {
    const sfdx = path.join(snapshotRoot, 'sfdx-project.json');
    const snapshotMeta = path.join(
        snapshotRoot,
        '.metadata-backup',
        'retrieval-metadata.json'
    );

    for (const required of [sfdx, snapshotMeta]) {
        try {
            await stat(required);
        } catch (error) {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_SNAPSHOT_INVALID,
                `Snapshot is missing required file: ${path.basename(required)}`
            );
        }
    }
}

async function removeEntry(targetPath) {
    await rm(targetPath, { recursive: true, force: true });
}

async function clearWorktreeExceptGit(gitWorktreePath) {
    const entries = await readdir(gitWorktreePath);

    for (const entry of entries) {
        if (entry === '.git') {
            continue;
        }

        await removeEntry(path.join(gitWorktreePath, entry));
    }
}

async function copyRecursive(source, destination) {
    const sourceStat = await stat(source);

    if (sourceStat.isDirectory()) {
        const base = path.basename(source);

        if (isDeniedName(base)) {
            return;
        }

        await mkdir(destination, { recursive: true });
        const children = await readdir(source);

        for (const child of children) {
            await copyRecursive(
                path.join(source, child),
                path.join(destination, child)
            );
        }

        return;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
}

async function removeDeniedFromWorktree(gitWorktreePath) {
    for (const name of TREE_SYNC_DENYLIST) {
        const target = path.join(gitWorktreePath, name);

        try {
            await stat(target);
            await removeEntry(target);
        } catch (error) {
            // absent
        }
    }
}

async function syncSnapshotToWorktree(gitWorktreePath, snapshotRoot) {
    await assertSnapshotValid(snapshotRoot);
    await clearWorktreeExceptGit(gitWorktreePath);
    await copyRecursive(snapshotRoot, gitWorktreePath);
    await removeDeniedFromWorktree(gitWorktreePath);
}

module.exports = {
    syncSnapshotToWorktree,
    assertSnapshotValid
};
