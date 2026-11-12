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
    resolveAnchorCommit,
    isAncestor
} = require('./gitMigrationAnchor.service');
const {
    remotePreflight,
    resolveRemoteBranchRef,
    cleanupMigrationClone,
    REF_STATUS
} = require('./gitMigrationRemote.service');
const {
    assertBranchIsNotAnchor
} = require('./gitMigrationAnchor.service');

const ALLOW = 'ALLOW';

async function assertLegacyPublishAllowed({ repoUrl, branchName } = {}) {
    if (!repoUrl || !branchName) {
        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_INVALID_REQUEST,
            'repoUrl and branchName are required.'
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

    try {
        const preflight = await remotePreflight(repoUrl);
        clonePath = preflight.clonePath;

        const anchorSha = await resolveAnchorCommit(clonePath);
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
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_MIGRATION_SHARED_REQUIRED,
                'Anchor exists; new branches require shared-history migration mode.'
            );
        }

        const descendant = await isAncestor(clonePath, anchorSha, ref.sha);

        if (descendant) {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_MIGRATION_LEGACY_BLOCKED,
                'Legacy force-push is not allowed for shared-history branches.'
            );
        }

        return { allowed: ALLOW, repoId, anchorSha };
    } finally {
        await cleanupMigrationClone(clonePath);
    }
}

module.exports = {
    ALLOW,
    assertLegacyPublishAllowed
};
