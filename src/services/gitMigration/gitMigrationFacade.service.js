'use strict';

const {
    isSharedHistoryEnabled,
    assertValidBranchName,
    sanitizeRepositoryId
} = require('./gitMigration.config');
const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const { publishSharedOrgSnapshot } = require('./gitMigrationPublish.service');
const { assertLegacyPublishAllowed } = require('./gitMigrationLegacyGuard.service');
const { publishLegacyOrgSnapshot } = require('./gitMigrationLegacyPublish.service');

async function publishOrgMigrationSnapshot({
    repoUrl,
    branchName,
    snapshotProjectPath
} = {}) {
    const branch = String(branchName || '').trim();

    if (!assertValidBranchName(branch)) {
        throw new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_INVALID_BRANCH_NAME,
            'Branch name format is invalid.'
        );
    }

    if (isSharedHistoryEnabled()) {
        return publishSharedOrgSnapshot({
            repoUrl,
            branchName: branch,
            snapshotProjectPath
        });
    }

    await assertLegacyPublishAllowed({ repoUrl, branchName: branch });
    await publishLegacyOrgSnapshot({
        projectPath: snapshotProjectPath,
        repoUrl,
        branchName: branch
    });

    return { success: true, mode: 'legacy' };
}

function logMigrationFailure(error, repoUrl) {
    const repoId = sanitizeRepositoryId(repoUrl);

    if (error instanceof GitMigrationError) {
        console.error(
            'GIT_MIGRATION_ERROR',
            repoId,
            error.code,
            error.message
        );
        return;
    }

    console.error('GIT_MIGRATION_ERROR', repoId, error.message || error);
}

module.exports = {
    publishOrgMigrationSnapshot,
    logMigrationFailure,
    isSharedHistoryEnabled: isSharedHistoryEnabled
};
