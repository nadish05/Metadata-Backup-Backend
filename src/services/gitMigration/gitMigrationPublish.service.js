'use strict';

const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const {
    assertValidBranchName,
    sanitizeRepositoryId
} = require('./gitMigration.config');
const {
    assertBranchIsNotAnchor,
    isAncestor,
    resolveAnchorCommit
} = require('./gitMigrationAnchor.service');
const {
    remotePreflight,
    resolveRemoteBranchRef,
    cleanupMigrationClone,
    REF_STATUS
} = require('./gitMigrationRemote.service');
const { syncSnapshotToWorktree } = require('./gitMigrationTreeSync.service');
const {
    acquireMigrationLock,
    releaseMigrationLock
} = require('./gitMigrationLock.service');
const { runGit, shellQuote } = require('./gitMigration.shell');

async function resolveBranchTipSha(clonePath, branchName) {
    const ref = await resolveRemoteBranchRef(clonePath, branchName);

    if (ref.status === REF_STATUS.LOOKUP_FAILED) {
        throw (
            ref.error ||
            new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_REF_LOOKUP_FAILED,
                'Unable to resolve remote branch ref.'
            )
        );
    }

    if (ref.status === REF_STATUS.INVALID) {
        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_REF_INVALID,
            'Remote branch ref is invalid.'
        );
    }

    if (ref.status === REF_STATUS.ABSENT) {
        return { present: false, tipSha: null };
    }

    return { present: true, tipSha: ref.sha };
}

async function publishSharedOrgSnapshot({
    repoUrl,
    branchName,
    snapshotProjectPath
} = {}) {
    if (!repoUrl || !branchName || !snapshotProjectPath) {
        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_INVALID_REQUEST,
            'repoUrl, branchName, and snapshotProjectPath are required.'
        );
    }

    if (!assertValidBranchName(branchName)) {
        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_INVALID_BRANCH_NAME,
            'Branch name format is invalid.'
        );
    }

    assertBranchIsNotAnchor(branchName);

    const repoId = sanitizeRepositoryId(repoUrl);
    let clonePath;
    let lockHeld = false;

    try {
        acquireMigrationLock(repoId, branchName);
        lockHeld = true;

        const preflight = await remotePreflight(repoUrl);
        clonePath = preflight.clonePath;

        const anchorSha = await resolveAnchorCommit(clonePath);
        const branchRef = await resolveBranchTipSha(clonePath, branchName);

        let expectedSha;
        let checkoutArg;

        if (branchRef.present) {
            const compatible = await isAncestor(
                clonePath,
                anchorSha,
                branchRef.tipSha
            );

            if (!compatible) {
                throw new GitMigrationError(
                    GIT_MIGRATION_ERROR.GIT_MIGRATION_BRANCH_HISTORY_INCOMPATIBLE,
                    'Branch history is incompatible with shared-history anchor.'
                );
            }

            expectedSha = branchRef.tipSha;
            checkoutArg = branchRef.tipSha;
        } else {
            expectedSha = null;
            checkoutArg = anchorSha;
        }

        await runGit(
            clonePath,
            `checkout -B ${shellQuote(branchName)} ${shellQuote(checkoutArg)}`
        );

        await syncSnapshotToWorktree(clonePath, snapshotProjectPath);
        await runGit(clonePath, 'config user.email "backup@system.com"');
        await runGit(clonePath, 'config user.name "Salesforce Backup Bot"');
        await runGit(clonePath, 'add -A');

        const commitMsg = `Org backup: ${branchName} ${new Date().toISOString()}`;
        await runGit(
            clonePath,
            `commit -m ${shellQuote(commitMsg)}`,
            { maxBuffer: 50 * 1024 * 1024 }
        ).catch((error) => {
            if (String(error.stderr || '').includes('nothing to commit')) {
                return runGit(
                    clonePath,
                    `commit --allow-empty -m ${shellQuote(commitMsg)}`
                );
            }

            throw error;
        });

        await runGit(clonePath, 'fetch origin');

        const branchAfterFetch = await resolveBranchTipSha(clonePath, branchName);
        const currentSha = branchAfterFetch.present
            ? branchAfterFetch.tipSha
            : null;

        if (currentSha !== expectedSha) {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_MIGRATION_CONCURRENCY_CONFLICT,
                'Remote branch changed before push; migration aborted.'
            );
        }

        const pushArgs = branchRef.present
            ? `push -u origin ${shellQuote(branchName)}`
            : `push -u origin ${shellQuote(branchName)}`;

        if (pushArgs.includes('--force')) {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_INVALID_REQUEST,
                'Force push is not permitted in shared-history mode.'
            );
        }

        try {
            await runGit(clonePath, pushArgs);
        } catch (error) {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_MIGRATION_PUSH_REJECTED,
                'Git push was rejected.',
                { cause: error.stderr || error.message }
            );
        }

        return { success: true, repoId, branchName };
    } finally {
        if (lockHeld) {
            releaseMigrationLock(repoId, branchName);
        }

        await cleanupMigrationClone(clonePath);
    }
}

module.exports = {
    publishSharedOrgSnapshot
};
