'use strict';

const crypto = require('crypto');

const ANCHOR_REF = 'history/anchor';
const ANCHOR_REMOTE = `origin/${ANCHOR_REF}`;
const ANCHOR_PROTECTED_REF = ANCHOR_REF;

const LOCK_TTL_MS = 90 * 60 * 1000;

const TREE_SYNC_DENYLIST = Object.freeze([
    '.sf',
    '.sfdx',
    'node_modules'
]);

const BRANCH_NAME_PATTERN =
    /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

function isSharedHistoryEnabled() {
    return (
        String(process.env.GIT_MIGRATION_SHARED_HISTORY || '')
            .trim()
            .toLowerCase() === 'true'
    );
}

function sanitizeRepositoryId(repoUrl) {
    if (!repoUrl) {
        return 'repo:unknown';
    }

    return `repo-${crypto.createHash('sha256').update(String(repoUrl)).digest('hex').slice(0, 12)}`;
}

function assertValidBranchName(branchName) {
    const name = String(branchName || '').trim();

    if (!name || name.length > 255) {
        return false;
    }

    if (!BRANCH_NAME_PATTERN.test(name)) {
        return false;
    }

    if (name.includes('..') || name.startsWith('/') || name.endsWith('/')) {
        return false;
    }

    return true;
}

module.exports = {
    ANCHOR_REF,
    ANCHOR_REMOTE,
    ANCHOR_PROTECTED_REF,
    LOCK_TTL_MS,
    TREE_SYNC_DENYLIST,
    isSharedHistoryEnabled,
    sanitizeRepositoryId,
    assertValidBranchName
};
