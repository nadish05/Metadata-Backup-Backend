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
const {
    buildGitExecDiagnostic,
    sanitizeGitOutput
} = require('./gitMigration.diagnostics');

const REF_STATUS = Object.freeze({
    PRESENT: 'PRESENT',
    ABSENT: 'ABSENT',
    LOOKUP_FAILED: 'LOOKUP_FAILED',
    INVALID: 'INVALID'
});

function mapRemoteFailure(error, context = {}) {
    const kind = classifyExecError(error);
    const gitDiagnostic = buildGitExecDiagnostic(error, context);
    const cause = sanitizeGitOutput(error?.stderr || error?.message || '');
    const details = {
        cause,
        gitDiagnostic
    };

    if (kind === 'auth') {
        return new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_REMOTE_AUTH_FAILED,
            'Git remote authentication failed.',
            details
        );
    }

    if (kind === 'network') {
        return new GitMigrationError(
            GIT_MIGRATION_ERROR.GIT_REMOTE_NETWORK_FAILED,
            'Git remote network request failed.',
            details
        );
    }

    return new GitMigrationError(
        GIT_MIGRATION_ERROR.GIT_REMOTE_FETCH_FAILED,
        'Git remote fetch failed.',
        details
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

        throw mapRemoteFailure(error, {
            stage: 'clone',
            command: 'git clone'
        });
    }

    try {
        await runGit(clonePath, 'fetch --all');
    } catch (error) {
        await rm(clonePath, { recursive: true, force: true }).catch(() => {});
        throw mapRemoteFailure(error, {
            stage: 'fetch_all',
            command: 'git fetch --all'
        });
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

function parseLsRemoteBranchLine(stdout) {
    const line = String(stdout || '').trim();

    if (!line) {
        return { status: REF_STATUS.ABSENT, sha: null };
    }

    const sha = line.split(/\s+/)[0];

    if (!/^[0-9a-f]{40}$/i.test(sha)) {
        return { status: REF_STATUS.INVALID, sha: null };
    }

    return { status: REF_STATUS.PRESENT, sha };
}

async function lsRemoteHasBranch(repoUrl, branchName) {
    const authenticatedUrl = getAuthenticatedRepoUrl(repoUrl);
    const ref = `refs/heads/${branchName}`;

    try {
        const result = await execAsync(
            `git ls-remote ${shellQuote(authenticatedUrl)} ${shellQuote(ref)}`
        );

        return parseLsRemoteBranchLine(result.stdout);
    } catch (error) {
        throw mapRemoteFailure(error, {
            stage: 'ls_remote',
            command: 'git ls-remote'
        });
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
    const ref = `refs/heads/${branchName}`;

    try {
        const result = await runGit(
            clonePath,
            `ls-remote ${shellQuote('origin')} ${shellQuote(ref)}`
        );

        return parseLsRemoteBranchLine(result.stdout);
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
            error: mapRemoteFailure(error, {
                stage: 'ls_remote',
                command: 'git ls-remote origin'
            })
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
    lsRemoteHasBranch,
    lsRemoteHasBranchFromClone,
    mapRemoteFailure
};
