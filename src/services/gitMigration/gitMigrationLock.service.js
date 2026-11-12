'use strict';

const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const { LOCK_TTL_MS } = require('./gitMigration.config');

const locks = new Map();

function lockKey(repoId, branchName) {
    return `${repoId}:${branchName}`;
}

function acquireMigrationLock(repoId, branchName, now = Date.now()) {
    const key = lockKey(repoId, branchName);
    const existing = locks.get(key);

    if (existing && existing.expiresAt > now) {
        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_MIGRATION_IN_PROGRESS,
            'A migration is already in progress for this repository branch.'
        );
    }

    locks.set(key, {
        acquiredAt: now,
        expiresAt: now + LOCK_TTL_MS
    });
}

function releaseMigrationLock(repoId, branchName) {
    locks.delete(lockKey(repoId, branchName));
}

function clearAllMigrationLocksForTests() {
    locks.clear();
}

module.exports = {
    acquireMigrationLock,
    releaseMigrationLock,
    clearAllMigrationLocksForTests
};
