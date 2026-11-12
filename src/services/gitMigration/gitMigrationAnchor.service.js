'use strict';

const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const {
    ANCHOR_REMOTE,
    ANCHOR_PROTECTED_REF
} = require('./gitMigration.config');
const { runGit, shellQuote } = require('./gitMigration.shell');

async function resolveAnchorCommit(clonePath) {
    try {
        const rev = await runGit(
            clonePath,
            `rev-parse --verify ${shellQuote(`${ANCHOR_REMOTE}^{commit}`)}`
        );
        const anchorSha = rev.stdout.trim();

        if (!/^[0-9a-f]{40}$/i.test(anchorSha)) {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_ANCHOR_INVALID,
                'Shared history anchor is not a valid commit.'
            );
        }

        const type = await runGit(clonePath, `cat-file -t ${shellQuote(anchorSha)}`);
        const objectType = type.stdout.trim();

        if (objectType !== 'commit') {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_ANCHOR_INVALID,
                'Shared history anchor is not a commit object.'
            );
        }

        return anchorSha;
    } catch (error) {
        if (error instanceof GitMigrationError) {
            throw error;
        }

        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_ANCHOR_NOT_FOUND,
            'Shared history anchor ref was not found.'
        );
    }
}

async function isAncestor(clonePath, ancestorSha, descendantSha) {
    try {
        await runGit(
            clonePath,
            `merge-base --is-ancestor ${shellQuote(ancestorSha)} ${shellQuote(descendantSha)}`
        );

        return true;
    } catch (error) {
        return false;
    }
}

function assertBranchIsNotAnchor(branchName) {
    if (String(branchName).trim() === ANCHOR_PROTECTED_REF) {
        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_INVALID_REQUEST,
            'Cannot publish to the protected anchor branch.'
        );
    }
}

module.exports = {
    resolveAnchorCommit,
    isAncestor,
    assertBranchIsNotAnchor
};
