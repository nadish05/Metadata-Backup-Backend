'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const mkdir = util.promisify(fs.mkdir);
const rm = util.promisify(fs.rm);

const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const { sanitizeRepositoryId } = require('./gitMigration.config');
const {
    getAuthenticatedRepoUrl,
    runGit,
    classifyExecError,
    execAsync,
    shellQuote
} = require('./gitMigration.shell');

const REF_STATUS = Object.freeze({
    PRESENT: 'PRESENT',
    ABSENT: 'ABSENT',
    LOOKUP_FAILED: 'LOOKUP_FAILED',
    INVALID: 'INVALID'
});

function mapRemoteFailure(error) {
    const kind = classifyExecError(error);

    if (kind === 'auth') {
        return new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_REMOTE_AUTH_FAILED,
            'Git remote authentication failed.'
        );
    }

    if (kind === 'network') {
        return new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_REMOTE_NETWORK_FAILED,
            'Git remote network request failed.'
        );
    }

    return new GitMigrationError(
        GIT_MIGRATION_ERROR.GIT_REMOTE_FETCH_FAILED,
        'Git remote fetch failed.',
        { cause: error.stderr || error.message }
    );
}

async function createMigrationClone(repoUrl) {
    const repoId = sanitizeRepositoryId(repoUrl);
    const clonePath = path.join(
        os.tmpdir(),
        `git-migration-clone-${repoId}-${Date.now()}`
    );
    const authenticatedUrl = getAuthenticatedRepoUrl(repoUrl);

    try {
        await mkdir(path.dirname(clonePath), { recursive: true });
        await execAsync(
            `git clone ${shellQuote(authenticatedUrl)} ${shellQuote(clonePath)}`
        );
    } catch (error) {
        if (/not an empty directory|does not appear to be a git repository|repository not found|404/.test(
            `${error.stderr || ''} ${error.message || ''}`.toLowerCase()
        )) {
            throw new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_REPOSITORY_INVALID,
                'Git repository is invalid or unavailable.'
            );
        }

        throw mapRemoteFailure(error);
    }

    try {
        await runGit(clonePath, 'fetch --all');
    } catch (error) {
        await rm(clonePath, { recursive: true, force: true }).catch(() => {});
        throw mapRemoteFailure(error);
    }

    try {
        await runGit(clonePath, 'config core.autocrlf false');
    } catch (error) {
        // non-fatal
    }

    return { clonePath, repoId };
}

async function remotePreflight(repoUrl) {
    const { clonePath, repoId } = await createMigrationClone(repoUrl);

    return { clonePath, repoId };
}

async function lsRemoteHasBranch(repoUrl, branchName) {
    const authenticatedUrl = getAuthenticatedRepoUrl(repoUrl);
    const ref = `refs/heads/${branchName}`;

    try {
        const result = await execAsync(
            `git ls-remote ${shellQuote(authenticatedUrl)} ${shellQuote(ref)}`
        );
        const line = String(result.stdout || '').trim();

        if (!line) {
            return { status: REF_STATUS.ABSENT, sha: null };
        }

        const sha = line.split(/\s+/)[0];

        if (!/^[0-9a-f]{40}$/i.test(sha)) {
            return { status: REF_STATUS.INVALID, sha: null };
        }

        return { status: REF_STATUS.PRESENT, sha };
    } catch (error) {
        throw mapRemoteFailure(error);
    }
}

async function resolveRemoteBranchRef(clonePath, branchName) {
    const localRef = `refs/remotes/origin/${branchName}`;

    try {
        const showRef = await runGit(
            clonePath,
            `show-ref --verify --quiet ${shellQuote(localRef)}`
        );
        void showRef;
    } catch (showRefError) {
        const lsRemoteResult = await lsRemoteHasBranchFromClone(
            clonePath,
            branchName
        );
        return lsRemoteResult;
    }

    try {
        const rev = await runGit(
            clonePath,
            `rev-parse --verify ${shellQuote(`${localRef}^{commit}`)}`
        );
        const sha = rev.stdout.trim();

        if (!/^[0-9a-f]{40}$/i.test(sha)) {
            return { status: REF_STATUS.INVALID, sha: null };
        }

        return { status: REF_STATUS.PRESENT, sha };
    } catch (error) {
        return {
            status: REF_STATUS.LOOKUP_FAILED,
            sha: null,
            error: new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_REF_LOOKUP_FAILED,
                'Unable to resolve remote branch ref.'
            )
        };
    }
}

async function lsRemoteHasBranchFromClone(clonePath, branchName) {
    let remoteUrl;

    try {
        const remote = await runGit(clonePath, 'remote get-url origin');
        remoteUrl = remote.stdout.trim();
    } catch (error) {
        return {
            status: REF_STATUS.LOOKUP_FAILED,
            sha: null,
            error: new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_REF_LOOKUP_FAILED,
                'Unable to read origin URL for ref lookup.'
            )
        };
    }

    if (!remoteUrl) {
        return {
            status: REF_STATUS.LOOKUP_FAILED,
            sha: null,
            error: new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_REPOSITORY_INVALID,
                'Origin remote URL is missing.'
            )
        };
    }

    try {
        const ls = await module.exports.lsRemoteHasBranch(remoteUrl, branchName);
        return ls;
    } catch (error) {
        if (error instanceof GitMigrationError) {
            return {
                status: REF_STATUS.LOOKUP_FAILED,
                sha: null,
                error
            };
        }

        return {
            status: REF_STATUS.LOOKUP_FAILED,
            sha: null,
            error: mapRemoteFailure(error)
        };
    }
}

async function cleanupMigrationClone(clonePath) {
    if (!clonePath) {
        return;
    }

    await rm(clonePath, { recursive: true, force: true }).catch(() => {});
}

module.exports = {
    REF_STATUS,
    remotePreflight,
    resolveRemoteBranchRef,
    cleanupMigrationClone,
    createMigrationClone,
    lsRemoteHasBranch
};
