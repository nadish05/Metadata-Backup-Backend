'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const { pathToFileURL } = require('url');

const execAsync = util.promisify(exec);
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);

const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const {
    cleanupMigrationClone,
    REF_STATUS
} = require('./gitMigrationRemote.service');

function loadRemoteModuleFresh({ preserveShell = false } = {}) {
    const remotePath = require.resolve('./gitMigrationRemote.service');
    const shellPath = require.resolve('./gitMigration.shell');
    delete require.cache[remotePath];

    if (!preserveShell) {
        delete require.cache[shellPath];
    }

    return require('./gitMigrationRemote.service');
}

let passCount = 0;

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            passCount += 1;
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function runGit(cwd, command) {
    await execAsync(command, { cwd, maxBuffer: 50 * 1024 * 1024 });
}

async function createBareRepository(barePath) {
    await mkdir(path.dirname(barePath), { recursive: true });
    await runGit(path.dirname(barePath), `git init --bare ${JSON.stringify(barePath)}`);
}

async function seedWithAnchor(barePath) {
    const workPath = `${barePath}.work`;
    await mkdir(workPath, { recursive: true });
    await runGit(workPath, `git clone ${JSON.stringify(barePath)} repo`);
    const repoPath = path.join(workPath, 'repo');
    await runGit(repoPath, 'git config user.email "test@local"');
    await runGit(repoPath, 'git config user.name "Test"');
    await runGit(repoPath, 'git checkout -b history/anchor');
    await writeFile(path.join(repoPath, 'README.md'), 'anchor\n');
    await runGit(repoPath, 'git add README.md');
    await runGit(repoPath, 'git commit -m anchor');
    await runGit(repoPath, 'git push -u origin history/anchor');
    return pathToFileURL(barePath).href;
}

async function main() {
    const tempRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'git-migration-remote-ref-')
    );

    await runTest('ls-remote from clone uses origin remote name', async () => {
        const barePath = path.join(tempRoot, 'origin-remote.git');
        await createBareRepository(barePath);
        const fileUrl = await seedWithAnchor(barePath);
        const remote = loadRemoteModuleFresh();
        const { clonePath } = await remote.createMigrationClone(fileUrl);

        const lsRemoteCalls = [];
        const shell = require('./gitMigration.shell');
        const origRunGit = shell.runGit;
        shell.runGit = async (cwd, args, options) => {
            if (String(args).startsWith('ls-remote')) {
                lsRemoteCalls.push(String(args));
            }

            return origRunGit(cwd, args, options);
        };
        const remoteLive = loadRemoteModuleFresh({ preserveShell: true });

        try {
            await runGit(
                clonePath,
                'git update-ref -d refs/remotes/origin/history/anchor'
            );
            await remoteLive.lsRemoteHasBranchFromClone(
                clonePath,
                'history/anchor'
            );

            assert.ok(lsRemoteCalls.length === 1);
            const call = lsRemoteCalls[0];
            assert.ok(call.includes('origin'));
            assert.ok(call.includes('refs/heads/history/anchor'));
            assert.ok(!/\shttps:\/\//i.test(call));
            assert.ok(!call.includes('@github.com'));
        } finally {
            shell.runGit = origRunGit;
            await cleanupMigrationClone(clonePath);
        }
    });

    await runTest('authenticated clone origin branch lookup PRESENT', async () => {
        const barePath = path.join(tempRoot, 'auth-origin.git');
        await createBareRepository(barePath);
        const fileUrl = await seedWithAnchor(barePath);
        const remote = loadRemoteModuleFresh();

        let clonePath;

        try {
            const created = await remote.createMigrationClone(fileUrl);
            clonePath = created.clonePath;

            await runGit(
                clonePath,
                `git remote set-url origin https://redacted-credential@github.com/example/repo.git`
            );
            await runGit(
                clonePath,
                `git remote set-url origin ${JSON.stringify(fileUrl)}`
            );
            await runGit(
                clonePath,
                'git update-ref -d refs/remotes/origin/history/anchor'
            );

            const ref = await remote.resolveRemoteBranchRef(
                clonePath,
                'history/anchor'
            );
            assert.strictEqual(ref.status, REF_STATUS.PRESENT);
            assert.ok(/^[0-9a-f]{40}$/i.test(ref.sha));
        } finally {
            await cleanupMigrationClone(clonePath);
        }
    });

    await runTest('missing branch returns ABSENT not LOOKUP_FAILED', async () => {
        const barePath = path.join(tempRoot, 'absent.git');
        await createBareRepository(barePath);
        const fileUrl = await seedWithAnchor(barePath);
        const remote = loadRemoteModuleFresh();
        const { clonePath } = await remote.createMigrationClone(fileUrl);

        try {
            const ref = await remote.resolveRemoteBranchRef(
                clonePath,
                'noSuchBranch'
            );
            assert.strictEqual(ref.status, REF_STATUS.ABSENT);
        } finally {
            await cleanupMigrationClone(clonePath);
        }
    });

    await runTest('getAuthenticatedRepoUrl not used for clone-origin branch lookup', async () => {
        const barePath = path.join(tempRoot, 'no-double-auth.git');
        await createBareRepository(barePath);
        const fileUrl = await seedWithAnchor(barePath);
        const remote = loadRemoteModuleFresh();
        const { clonePath } = await remote.createMigrationClone(fileUrl);

        const shell = require('./gitMigration.shell');
        let authUrlCalls = 0;
        const origAuth = shell.getAuthenticatedRepoUrl;
        shell.getAuthenticatedRepoUrl = (...args) => {
            authUrlCalls += 1;
            return origAuth(...args);
        };
        const remoteLive = loadRemoteModuleFresh({ preserveShell: true });

        try {
            authUrlCalls = 0;
            await runGit(
                clonePath,
                'git remote set-url origin https://redacted-credential@github.com/example/repo.git'
            );
            await runGit(
                clonePath,
                `git remote set-url origin ${JSON.stringify(fileUrl)}`
            );
            await runGit(
                clonePath,
                'git update-ref -d refs/remotes/origin/history/anchor'
            );
            await remoteLive.resolveRemoteBranchRef(clonePath, 'history/anchor');
            assert.strictEqual(authUrlCalls, 0);
        } finally {
            shell.getAuthenticatedRepoUrl = origAuth;
            await cleanupMigrationClone(clonePath);
        }
    });

    await runTest('lsRemoteHasBranchFromClone auth errors classify as AUTH', async () => {
        const barePath = path.join(tempRoot, 'auth-err.git');
        await createBareRepository(barePath);
        const fileUrl = await seedWithAnchor(barePath);
        const remoteBootstrap = loadRemoteModuleFresh();
        const { clonePath } = await remoteBootstrap.createMigrationClone(fileUrl);

        const shell = require('./gitMigration.shell');
        const origRunGit = shell.runGit;
        shell.runGit = async (cwd, args, options) => {
            if (String(args).startsWith('ls-remote')) {
                const err = new Error('auth failed');
                err.code = 128;
                err.stderr = 'remote: Invalid username or password.';
                throw err;
            }

            return origRunGit(cwd, args, options);
        };
        const remote = loadRemoteModuleFresh({ preserveShell: true });

        try {
            const ref = await remote.lsRemoteHasBranchFromClone(
                clonePath,
                'history/anchor'
            );
            assert.strictEqual(ref.status, REF_STATUS.LOOKUP_FAILED);
            assert.ok(ref.error instanceof GitMigrationError);
            assert.strictEqual(
                ref.error.code,
                GIT_MIGRATION_ERROR.GIT_REMOTE_AUTH_FAILED
            );
            assert.strictEqual(ref.error.details.gitDiagnostic.stage, 'ls_remote');
            assert.strictEqual(
                ref.error.details.gitDiagnostic.command,
                'git ls-remote origin'
            );
        } finally {
            shell.runGit = origRunGit;
            await cleanupMigrationClone(clonePath);
        }
    });

    await runTest('lsRemoteHasBranchFromClone network errors classify as NETWORK', async () => {
        const barePath = path.join(tempRoot, 'net-err.git');
        await createBareRepository(barePath);
        const fileUrl = await seedWithAnchor(barePath);
        const remoteBootstrap = loadRemoteModuleFresh();
        const { clonePath } = await remoteBootstrap.createMigrationClone(fileUrl);

        const shell = require('./gitMigration.shell');
        const origRunGit = shell.runGit;
        shell.runGit = async (cwd, args, options) => {
            if (String(args).startsWith('ls-remote')) {
                const err = new Error('network');
                err.code = 128;
                err.stderr =
                    'fatal: unable to access: Could not resolve host: github.com';
                throw err;
            }

            return origRunGit(cwd, args, options);
        };
        const remote = loadRemoteModuleFresh({ preserveShell: true });

        try {
            const ref = await remote.lsRemoteHasBranchFromClone(
                clonePath,
                'history/anchor'
            );
            assert.strictEqual(ref.status, REF_STATUS.LOOKUP_FAILED);
            assert.strictEqual(
                ref.error.code,
                GIT_MIGRATION_ERROR.GIT_REMOTE_NETWORK_FAILED
            );
        } finally {
            shell.runGit = origRunGit;
            await cleanupMigrationClone(clonePath);
        }
    });

    console.log(`\nGit migration remote ref: ${passCount} passed`);
}

main();
