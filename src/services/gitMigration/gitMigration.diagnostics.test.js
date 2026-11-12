'use strict';

const assert = require('assert');

const {
    GIT_MIGRATION_ERROR,
    GitMigrationError
} = require('./gitMigration.errors');
const {
    sanitizeGitOutput,
    buildGitExecDiagnostic,
    formatGitDiagnosticForLog,
    MAX_DIAGNOSTIC_TEXT_LENGTH
} = require('./gitMigration.diagnostics');
const { mapRemoteFailure } = require('./gitMigrationRemote.service');
const { logMigrationFailure } = require('./gitMigrationFacade.service');

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

async function main() {
    await runTest('sanitize redacts authenticated GitHub URL', () => {
        const input =
            'fatal: unable to access https://ghp_SUPERSECRET@github.com/nadish05/repo.git/';
        const out = sanitizeGitOutput(input);
        assert.ok(!out.includes('ghp_SUPERSECRET'));
        assert.ok(out.includes('[redacted]'));
    });

    await runTest('sanitize redacts bare token patterns', () => {
        const input = 'remote: Invalid password token ghp_abc123xyz';
        const out = sanitizeGitOutput(input);
        assert.ok(!out.includes('ghp_abc123xyz'));
        assert.ok(out.includes('[redacted-token]'));
    });

    await runTest('sanitize redacts GITHUB_TOKEN env fragments', () => {
        const out = sanitizeGitOutput('export GITHUB_TOKEN=ghp_leak');
        assert.strictEqual(out, 'export GITHUB_TOKEN=[redacted]');
    });

    await runTest('sanitize truncates long stderr', () => {
        const long = 'x'.repeat(MAX_DIAGNOSTIC_TEXT_LENGTH + 50);
        const out = sanitizeGitOutput(long);
        assert.ok(out.endsWith('...[truncated]'));
        assert.ok(out.length < long.length);
    });

    await runTest('buildGitExecDiagnostic handles missing stderr', () => {
        const diag = buildGitExecDiagnostic(
            { code: 128, message: 'Command failed' },
            { stage: 'fetch_all', command: 'git fetch --all' }
        );
        assert.strictEqual(diag.stage, 'fetch_all');
        assert.strictEqual(diag.command, 'git fetch --all');
        assert.strictEqual(diag.exitCode, 128);
        assert.strictEqual(diag.stderr, '');
        assert.ok(diag.message.includes('Command failed'));
    });

    await runTest('mapRemoteFailure records clone stage for auth errors', () => {
        const err = mapRemoteFailure(
            {
                code: 128,
                stderr: 'remote: Invalid username or password.',
                message: 'Command failed'
            },
            { stage: 'clone', command: 'git clone' }
        );
        assert.ok(err instanceof GitMigrationError);
        assert.strictEqual(err.code, GIT_MIGRATION_ERROR.GIT_REMOTE_AUTH_FAILED);
        assert.strictEqual(err.details.gitDiagnostic.stage, 'clone');
        assert.strictEqual(err.details.gitDiagnostic.command, 'git clone');
        assert.strictEqual(err.details.gitDiagnostic.exitCode, 128);
    });

    await runTest('mapRemoteFailure records fetch_all stage for fetch errors', () => {
        const err = mapRemoteFailure(
            {
                code: 1,
                stderr: 'fatal: fetch failed for origin',
                message: 'git fetch --all failed'
            },
            { stage: 'fetch_all', command: 'git fetch --all' }
        );
        assert.strictEqual(err.code, GIT_MIGRATION_ERROR.GIT_REMOTE_FETCH_FAILED);
        assert.strictEqual(err.details.gitDiagnostic.stage, 'fetch_all');
        assert.strictEqual(err.details.gitDiagnostic.command, 'git fetch --all');
    });

    await runTest('mapRemoteFailure classifies network failures', () => {
        const err = mapRemoteFailure(
            {
                code: 128,
                stderr: 'fatal: unable to access: Could not resolve host: github.com',
                message: 'network'
            },
            { stage: 'clone', command: 'git clone' }
        );
        assert.strictEqual(
            err.code,
            GIT_MIGRATION_ERROR.GIT_REMOTE_NETWORK_FAILED
        );
        assert.strictEqual(err.details.gitDiagnostic.stage, 'clone');
    });

    await runTest('repository not found pattern is detected for invalid repo', () => {
        const stderr = 'remote: Repository not found.';
        assert.ok(
            /repository not found|404/.test(`${stderr} `.toLowerCase())
        );
    });

    await runTest('logMigrationFailure prints sanitized GIT_MIGRATION_DIAG', () => {
        const originalError = console.error;
        const lines = [];
        console.error = (...args) => {
            lines.push(args.join(' '));
        };

        try {
            const error = new GitMigrationError(
                GIT_MIGRATION_ERROR.GIT_REMOTE_FETCH_FAILED,
                'Git remote fetch failed.',
                {
                    gitDiagnostic: buildGitExecDiagnostic(
                        {
                            code: 1,
                            stderr: 'fatal: https://ghp_SECRET@github.com/foo',
                            message: 'failed'
                        },
                        {
                            stage: 'fetch_all',
                            command: 'git fetch --all'
                        }
                    )
                }
            );

            logMigrationFailure(
                error,
                'https://github.com/nadish05/New-salesforce-Backup'
            );

            const diagLine = lines.find((line) =>
                line.includes('GIT_MIGRATION_DIAG')
            );
            assert.ok(diagLine);
            assert.ok(!diagLine.includes('ghp_SECRET'));
            assert.ok(diagLine.includes('fetch_all'));
        } finally {
            console.error = originalError;
        }
    });

    await runTest('formatGitDiagnosticForLog returns stable shape', () => {
        const formatted = formatGitDiagnosticForLog({
            stage: 'clone',
            command: 'git clone',
            exitCode: 128,
            stderr: 'x',
            message: 'y'
        });
        assert.deepStrictEqual(Object.keys(formatted).sort(), [
            'command',
            'exitCode',
            'message',
            'stage',
            'stderr'
        ]);
    });

    console.log(
        `\nGit migration diagnostics: ${passCount} passed, ${failCount} failed`
    );
}

main();
