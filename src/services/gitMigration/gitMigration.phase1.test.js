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
const { assertLegacyPublishAllowed } = require('./gitMigrationLegacyGuard.service');
const {
    createMigrationClone,
    resolveRemoteBranchRef,
    cleanupMigrationClone,
    REF_STATUS
} = require('./gitMigrationRemote.service');
const { publishOrgMigrationSnapshot } = require('./gitMigrationFacade.service');
const { publishSharedOrgSnapshot } = require('./gitMigrationPublish.service');
const { classifyExecError } = require('./gitMigration.shell');
const { isSharedHistoryEnabled } = require('./gitMigration.config');
const { clearAllMigrationLocksForTests } = require('./gitMigrationLock.service');
const legacyPublish = require('./gitMigrationLegacyPublish.service');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            passCount += 1;
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            failCount += 1;
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function runGit(cwd, command) {
    await execAsync(command, {
        cwd,
        maxBuffer: 50 * 1024 * 1024
    });
}

async function writeValidSnapshot(snapshotRoot) {
    await mkdir(path.join(snapshotRoot, '.metadata-backup'), { recursive: true });
    await writeFile(
        path.join(snapshotRoot, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] })
    );
    await writeFile(
        path.join(snapshotRoot, '.metadata-backup', 'retrieval-metadata.json'),
        JSON.stringify({ capturedAt: new Date().toISOString() })
    );
}

async function createBareRepository(barePath) {
    await mkdir(path.dirname(barePath), { recursive: true });
    await runGit(path.dirname(barePath), `git init --bare ${JSON.stringify(barePath)}`);
}

async function seedRepository({
    barePath,
    withAnchor = true,
    withOrphanBranch = false,
    withDescendantBranch = false
} = {}) {
    const workPath = `${barePath}.work`;
    await mkdir(workPath, { recursive: true });
    await runGit(workPath, `git clone ${JSON.stringify(barePath)} repo`);
    const repoPath = path.join(workPath, 'repo');
    await runGit(repoPath, 'git config user.email "test@local"');
    await runGit(repoPath, 'git config user.name "Test"');

    let anchorSha = null;

    if (withAnchor) {
        await runGit(repoPath, 'git checkout -b history/anchor');
        await writeFile(path.join(repoPath, 'README.md'), 'anchor\n');
        await runGit(repoPath, 'git add README.md');
        await runGit(repoPath, 'git commit -m "anchor scaffold"');
        anchorSha = (
            await execAsync('git rev-parse HEAD', { cwd: repoPath })
        ).stdout.trim();

        await runGit(repoPath, 'git push -u origin history/anchor');

    }

    if (withOrphanBranch) {
        await runGit(repoPath, 'git checkout --orphan orphanGym');
        await runGit(repoPath, 'git rm -rf .');
        await writeFile(path.join(repoPath, 'orphan.txt'), 'orphan\n');
        await runGit(repoPath, 'git add orphan.txt');
        await runGit(repoPath, 'git commit -m "orphan root"');
        await runGit(repoPath, 'git push -u origin orphanGym');
    }

    if (withDescendantBranch && anchorSha) {
        await runGit(repoPath, 'git checkout history/anchor');
        await runGit(repoPath, 'git checkout -b orgDescendant');
        await writeFile(path.join(repoPath, 'descendant.txt'), 'x\n');
        await runGit(repoPath, 'git add descendant.txt');
        await runGit(repoPath, 'git commit -m "descendant"');
        await runGit(repoPath, 'git push -u origin orgDescendant');
    }

    return {
        fileUrl: pathToFileURL(barePath).href,
        workPath,
        anchorSha
    };
}

function expectCode(error, code) {
    assert.ok(error instanceof GitMigrationError, 'expected GitMigrationError');
    assert.strictEqual(error.code, code);
}

async function main() {
    const tempRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'git-migration-phase1-')
    );

    const originalSharedFlag = process.env.GIT_MIGRATION_SHARED_HISTORY;
    const originalGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    async function withEnv(name, envPatch, fn) {
        const snapshot = {};

        for (const key of Object.keys(envPatch)) {
            snapshot[key] = process.env[key];
            if (envPatch[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = envPatch[key];
            }
        }

        try {
            await fn();
        } finally {
            for (const key of Object.keys(snapshot)) {
                if (snapshot[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = snapshot[key];
                }
            }
        }
    }

    await runTest('T1 — legacy migrate; anchor missing', async () => {
        const barePath = path.join(tempRoot, 't1.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({
            barePath,
            withAnchor: false
        });

        await withEnv('T1', { GIT_MIGRATION_SHARED_HISTORY: 'false' }, async () => {
            try {
                await assertLegacyPublishAllowed({
                    repoUrl: fileUrl,
                    branchName: 'Gym'
                });
                assert.fail('expected failure');
            } catch (error) {
                expectCode(error, GIT_MIGRATION_ERROR.GIT_ANCHOR_NOT_FOUND);
            }
        });
    });

    await runTest('T2 — legacy migrate; anchor invalid (not commit)', async () => {
        const barePath = path.join(tempRoot, 't2.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({
            barePath,
            withAnchor: true
        });

        const { clonePath } = await createMigrationClone(fileUrl);
        const shellPath = require.resolve('./gitMigration.shell');
        const anchorPath = require.resolve('./gitMigrationAnchor.service');
        delete require.cache[shellPath];
        delete require.cache[anchorPath];

        const shell = require('./gitMigration.shell');
        const origRunGit = shell.runGit;
        shell.runGit = async (cwd, args, options) => {
            if (String(args).startsWith('cat-file -t')) {
                return { stdout: 'tag\n', stderr: '' };
            }

            return origRunGit(cwd, args, options);
        };

        const { resolveAnchorCommit } = require('./gitMigrationAnchor.service');

        try {
            try {
                await resolveAnchorCommit(clonePath);
                assert.fail('expected failure');
            } catch (error) {
                expectCode(error, GIT_MIGRATION_ERROR.GIT_ANCHOR_INVALID);
            }
        } finally {
            shell.runGit = origRunGit;
            await cleanupMigrationClone(clonePath);
        }
    });

    await runTest('T3 — legacy migrate; fetch fails (invalid repo)', async () => {
        const missingUrl = pathToFileURL(
            path.join(tempRoot, 'does-not-exist-remote.git')
        ).href;

        await withEnv('T3', { GIT_MIGRATION_SHARED_HISTORY: 'false' }, async () => {
            try {
                await assertLegacyPublishAllowed({
                    repoUrl: missingUrl,
                    branchName: 'Gym'
                });
                assert.fail('expected failure');
            } catch (error) {
                assert.ok(error instanceof GitMigrationError);
                assert.ok(
                    [
                        GIT_MIGRATION_ERROR.GIT_REPOSITORY_INVALID,
                        GIT_MIGRATION_ERROR.GIT_REMOTE_FETCH_FAILED,
                        GIT_MIGRATION_ERROR.GIT_REMOTE_NETWORK_FAILED
                    ].includes(error.code)
                );
            }
        });
    });

    await runTest('T4 — auth failure classification', async () => {
        const kind = classifyExecError({
            stderr: 'remote: Invalid username or password.',
            message: 'authentication failed'
        });
        assert.strictEqual(kind, 'auth');
    });

    await runTest('T5 — anchor exists; legacy; new branch absent', async () => {
        const barePath = path.join(tempRoot, 't5.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({ barePath, withAnchor: true });

        await withEnv('T5', { GIT_MIGRATION_SHARED_HISTORY: 'false' }, async () => {
            try {
                await assertLegacyPublishAllowed({
                    repoUrl: fileUrl,
                    branchName: 'brandNewOrg'
                });
                assert.fail('expected failure');
            } catch (error) {
                expectCode(error, GIT_MIGRATION_ERROR.GIT_MIGRATION_SHARED_REQUIRED);
            }
        });
    });

    await runTest('T6 — shared; new branch from anchor', async () => {
        const barePath = path.join(tempRoot, 't6.git');
        await createBareRepository(barePath);
        const { fileUrl, anchorSha } = await seedRepository({
            barePath,
            withAnchor: true
        });
        const snapshot = path.join(tempRoot, 't6-snapshot');
        await mkdir(snapshot, { recursive: true });
        await writeValidSnapshot(snapshot);

        await withEnv('T6', { GIT_MIGRATION_SHARED_HISTORY: 'true' }, async () => {
            clearAllMigrationLocksForTests();
            await publishOrgMigrationSnapshot({
                repoUrl: fileUrl,
                branchName: 'newOrgFromAnchor',
                snapshotProjectPath: snapshot
            });

            const verify = await createMigrationClone(fileUrl);
            const ref = await resolveRemoteBranchRef(
                verify.clonePath,
                'newOrgFromAnchor'
            );
            assert.strictEqual(ref.status, REF_STATUS.PRESENT);
            const mb = await execAsync(`git merge-base ${anchorSha} ${ref.sha}`, {
                cwd: verify.clonePath
            });
            assert.ok(mb.stdout.trim());
            await cleanupMigrationClone(verify.clonePath);
        });
    });

    await runTest('T7 — legacy; unrelated existing branch allows force', async () => {
        const barePath = path.join(tempRoot, 't7.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({
            barePath,
            withAnchor: true,
            withOrphanBranch: true
        });
        const snapshot = path.join(tempRoot, 't7-snapshot');
        await mkdir(snapshot, { recursive: true });
        await writeValidSnapshot(snapshot);

        const beforeTip = (
            await execAsync(
                `git ls-remote ${JSON.stringify(fileUrl)} refs/heads/orphanGym`
            )
        ).stdout.trim().split(/\s+/)[0];

        await withEnv('T7', { GIT_MIGRATION_SHARED_HISTORY: 'false' }, async () => {
            clearAllMigrationLocksForTests();
            const result = await publishOrgMigrationSnapshot({
                repoUrl: fileUrl,
                branchName: 'orphanGym',
                snapshotProjectPath: snapshot
            });
            assert.strictEqual(result.mode, 'legacy');
        });

        const afterTip = (
            await execAsync(
                `git ls-remote ${JSON.stringify(fileUrl)} refs/heads/orphanGym`
            )
        ).stdout.trim().split(/\s+/)[0];
        assert.notStrictEqual(beforeTip, afterTip);
    });

    await runTest('T8 — legacy; descendant branch blocked', async () => {
        const barePath = path.join(tempRoot, 't8.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({
            barePath,
            withAnchor: true,
            withDescendantBranch: true
        });

        await withEnv('T8', { GIT_MIGRATION_SHARED_HISTORY: 'false' }, async () => {
            try {
                await assertLegacyPublishAllowed({
                    repoUrl: fileUrl,
                    branchName: 'orgDescendant'
                });
                assert.fail('expected failure');
            } catch (error) {
                expectCode(error, GIT_MIGRATION_ERROR.GIT_MIGRATION_LEGACY_BLOCKED);
            }
        });
    });

    await runTest('T9 — shared; unrelated existing branch rejected', async () => {
        const barePath = path.join(tempRoot, 't9.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({
            barePath,
            withAnchor: true,
            withOrphanBranch: true
        });
        const snapshot = path.join(tempRoot, 't9-snapshot');
        await mkdir(snapshot, { recursive: true });
        await writeValidSnapshot(snapshot);

        const beforeTip = (
            await execAsync(
                `git ls-remote ${JSON.stringify(fileUrl)} refs/heads/orphanGym`
            )
        ).stdout.trim().split(/\s+/)[0];

        await withEnv('T9', { GIT_MIGRATION_SHARED_HISTORY: 'true' }, async () => {
            clearAllMigrationLocksForTests();
            try {
                await publishSharedOrgSnapshot({
                    repoUrl: fileUrl,
                    branchName: 'orphanGym',
                    snapshotProjectPath: snapshot
                });
                assert.fail('expected failure');
            } catch (error) {
                expectCode(
                    error,
                    GIT_MIGRATION_ERROR.GIT_MIGRATION_BRANCH_HISTORY_INCOMPATIBLE
                );
            }
        });

        const afterTip = (
            await execAsync(
                `git ls-remote ${JSON.stringify(fileUrl)} refs/heads/orphanGym`
            )
        ).stdout.trim().split(/\s+/)[0];
        assert.strictEqual(afterTip, beforeTip);
    });

    await runTest('T10 — show-ref miss + ls-remote hit is PRESENT', async () => {
        const barePath = path.join(tempRoot, 't10.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({
            barePath,
            withAnchor: true,
            withOrphanBranch: true
        });

        const { clonePath } = await createMigrationClone(fileUrl);
        await runGit(
            clonePath,
            'git update-ref -d refs/remotes/origin/orphanGym'
        );

        const ref = await resolveRemoteBranchRef(clonePath, 'orphanGym');
        assert.strictEqual(ref.status, REF_STATUS.PRESENT);
        assert.ok(/^[0-9a-f]{40}$/i.test(ref.sha));
        await cleanupMigrationClone(clonePath);
    });

    await runTest('T11 — confirmed ABSENT ref', async () => {
        const barePath = path.join(tempRoot, 't11.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({ barePath, withAnchor: true });
        const { clonePath } = await createMigrationClone(fileUrl);
        const ref = await resolveRemoteBranchRef(clonePath, 'noSuchBranch');
        assert.strictEqual(ref.status, REF_STATUS.ABSENT);
        await cleanupMigrationClone(clonePath);

        await withEnv('T11', { GIT_MIGRATION_SHARED_HISTORY: 'false' }, async () => {
            try {
                await assertLegacyPublishAllowed({
                    repoUrl: fileUrl,
                    branchName: 'noSuchBranch'
                });
                assert.fail('expected failure');
            } catch (error) {
                expectCode(error, GIT_MIGRATION_ERROR.GIT_MIGRATION_SHARED_REQUIRED);
            }
        });
    });

    await runTest('T12 — ref lookup failure is not ABSENT', async () => {
        const barePath = path.join(tempRoot, 't12.git');
        await createBareRepository(barePath);
        const { fileUrl } = await seedRepository({
            barePath,
            withAnchor: true,
            withOrphanBranch: true
        });
        const { clonePath } = await createMigrationClone(fileUrl);

        await runGit(
            clonePath,
            'git update-ref -d refs/remotes/origin/orphanGym'
        );

        const shellPath = require.resolve('./gitMigration.shell');
        const remotePath = require.resolve('./gitMigrationRemote.service');
        delete require.cache[shellPath];
        delete require.cache[remotePath];

        const shell = require('./gitMigration.shell');
        const origRunGit = shell.runGit;

        shell.runGit = async (cwd, args, options) => {
            if (String(args).startsWith('ls-remote')) {
                const err = new Error('ls-remote failed');
                err.code = 128;
                err.stderr = 'fatal: simulated ls-remote failure';
                throw err;
            }

            return origRunGit(cwd, args, options);
        };

        const {
            resolveRemoteBranchRef: resolveRefFresh
        } = require('./gitMigrationRemote.service');

        try {
            const ref = await resolveRefFresh(clonePath, 'orphanGym');
            assert.strictEqual(ref.status, REF_STATUS.LOOKUP_FAILED);
            assert.ok(ref.error instanceof GitMigrationError);
            assert.strictEqual(
                ref.error.code,
                GIT_MIGRATION_ERROR.GIT_REMOTE_FETCH_FAILED
            );
        } finally {
            shell.runGit = origRunGit;
            delete require.cache[shellPath];
            delete require.cache[remotePath];
            await cleanupMigrationClone(clonePath);
        }
    });

    await runTest('T13 — shared push argv never contains --force', async () => {
        const publishSource = fs.readFileSync(
            path.join(__dirname, 'gitMigrationPublish.service.js'),
            'utf8'
        );
        assert.ok(/push -u origin/.test(publishSource));
        assert.ok(
            !/runGit\([^)]*push[^)]*--force/.test(publishSource)
        );
        assert.ok(publishSource.includes('Force push is not permitted'));
    });

    await runTest('T14 — shared failure does not invoke legacy publish', async () => {
        let legacyCalls = 0;
        const original = legacyPublish.publishLegacyOrgSnapshot;
        legacyPublish.publishLegacyOrgSnapshot = async () => {
            legacyCalls += 1;
        };

        try {
            await withEnv('T14', { GIT_MIGRATION_SHARED_HISTORY: 'true' }, async () => {
                try {
                    await publishOrgMigrationSnapshot({
                        repoUrl: pathToFileURL(path.join(tempRoot, 'missing.git')).href,
                        branchName: 'x',
                        snapshotProjectPath: path.join(tempRoot, 't14-snap')
                    });
                } catch (error) {
                    assert.ok(error instanceof GitMigrationError);
                }
                assert.strictEqual(legacyCalls, 0);
            });
        } finally {
            legacyPublish.publishLegacyOrgSnapshot = original;
        }
    });

    await runTest('T15 — shared flag skips retrieveAllMetadata Git block', async () => {
        const source = await fs.promises.readFile(
            path.join(__dirname, '../../controllers/metadata.controller.js'),
            'utf8'
        );
        assert.ok(source.includes('isSharedHistoryEnabled()'));
        assert.ok(
            source.includes(
                'Shared-history mode: skipping retrieveAllMetadata Git publish'
            )
        );

        await withEnv('T15a', { GIT_MIGRATION_SHARED_HISTORY: 'true' }, () => {
            assert.strictEqual(isSharedHistoryEnabled(), true);
        });
        await withEnv('T15b', { GIT_MIGRATION_SHARED_HISTORY: 'false' }, () => {
            assert.strictEqual(isSharedHistoryEnabled(), false);
        });
    });

    console.log(`\nPhase 1 git migration: ${passCount} passed, ${failCount} failed`);

    if (originalSharedFlag === undefined) {
        delete process.env.GIT_MIGRATION_SHARED_HISTORY;
    } else {
        process.env.GIT_MIGRATION_SHARED_HISTORY = originalSharedFlag;
    }

    if (originalGithubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
    } else {
        process.env.GITHUB_TOKEN = originalGithubToken;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
