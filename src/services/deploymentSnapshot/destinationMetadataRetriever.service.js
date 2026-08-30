'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');

const { ensureSfdxProject } = require('../sfdxProject.service');
const {
    refreshAccessToken,
    loginSfOrg,
    shellQuote
} = require('../checkOnlyDeployment.service');
const { packMemberFiles } = require('./destinationMemberArtifact.service');

const mkdir = util.promisify(fs.mkdir);
const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const stat = util.promisify(fs.stat);
const rm = util.promisify(fs.rm);
const defaultExecAsync = util.promisify(exec);

const SKIP_DIR_NAMES = new Set(['.sf', '.sfdx', '.git', 'node_modules']);
const SKIP_FILE_NAMES = new Set(['sfdx-project.json']);
const MAX_DIAGNOSTIC_TEXT_LENGTH = 4096;

const SECRET_REDACTION_PATTERNS = [
    /SF_ACCESS_TOKEN\s*=\s*["'][^"']*["']/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /\brefresh[_-]?token["']?\s*[:=]\s*["'][^"']*["']/gi,
    /\baccess[_-]?token["']?\s*[:=]\s*["'][^"']*["']/gi,
    /\bclient[_-]?secret["']?\s*[:=]\s*["'][^"']*["']/gi,
    /\bAuthorization:\s*[^\s"']+/gi
];

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function redactDiagnosticText(value) {
    let text = String(value || '');

    for (const pattern of SECRET_REDACTION_PATTERNS) {
        text = text.replace(pattern, '[REDACTED]');
    }

    if (text.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
        return `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}...[truncated]`;
    }

    return text;
}

function extractJsonPayload(stdout) {
    const text = String(stdout || '').trim();

    if (!text) {
        return null;
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start < 0 || end < start) {
        return null;
    }

    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch (error) {
        return null;
    }
}

function collectRetrieveFileStrings(files) {
    if (!Array.isArray(files)) {
        return [];
    }

    return files.map((file) => {
        if (typeof file === 'string') {
            return file;
        }

        if (!file || typeof file !== 'object') {
            return String(file);
        }

        return [
            file.filePath,
            file.path,
            file.fullName,
            file.type,
            file.state
        ]
            .filter(Boolean)
            .join(' ');
    });
}

function summarizeRetrieveCliOutput(stdout) {
    const text = String(stdout || '').trim();

    if (!text) {
        return {
            parsed: false,
            reason: 'empty_stdout'
        };
    }

    const payload = extractJsonPayload(text);

    if (!payload) {
        return {
            parsed: false,
            reason: 'invalid_json',
            stdoutLength: text.length
        };
    }

    const result =
        payload.result && typeof payload.result === 'object'
            ? payload.result
            : payload;
    const files = result.files || result.fileProperties || [];
    const failures =
        result.failures ||
        (Array.isArray(result.messages) ? result.messages : null) ||
        payload.warnings ||
        [];

    return {
        parsed: true,
        status: payload.status,
        message:
            typeof payload.message === 'string' ? payload.message : null,
        fileCount: collectRetrieveFileStrings(files).length,
        failureCount: Array.isArray(failures) ? failures.length : 0,
        failures: Array.isArray(failures) ? failures.slice(0, 25) : failures
    };
}

function extractCliFailureMessages(summary, stderr) {
    const messages = [];

    if (summary?.parsed) {
        if (summary.message) {
            messages.push(summary.message);
        }

        if (Array.isArray(summary.failures)) {
            for (const failure of summary.failures) {
                if (!failure) {
                    continue;
                }

                if (typeof failure === 'string') {
                    messages.push(failure);
                    continue;
                }

                if (failure.message) {
                    messages.push(String(failure.message));
                    continue;
                }

                if (failure.problem) {
                    messages.push(String(failure.problem));
                    continue;
                }

                messages.push(JSON.stringify(failure));
            }
        }
    }

    const stderrText = String(stderr || '').trim();

    if (!messages.length && stderrText) {
        messages.push(stderrText);
    }

    return messages
        .map((message) => redactDiagnosticText(message).trim())
        .filter(Boolean);
}

function buildExpectedMemberSourcePaths(metadataType, metadataName) {
    if (metadataType === 'ApexClass') {
        const base = `force-app/main/default/classes/${metadataName}`;

        return {
            cls: `${base}.cls`,
            metaXml: `${base}.cls-meta.xml`
        };
    }

    return null;
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

async function listWorkspaceTopLevel(workspacePath) {
    if (!(await pathExists(workspacePath))) {
        return [];
    }

    const entries = await readdir(workspacePath, { withFileTypes: true });

    return entries.map((entry) => entry.name).sort();
}

async function buildExpectedPathChecks({
    workspacePath,
    metadataType,
    metadataName,
    retrievedFiles
}) {
    const expectedPaths = buildExpectedMemberSourcePaths(
        metadataType,
        metadataName
    );

    if (!expectedPaths) {
        return null;
    }

    const retrievedPathSet = new Set(
        retrievedFiles.map((file) => file.relativePath)
    );
    const checks = {};

    for (const [key, relativePath] of Object.entries(expectedPaths)) {
        checks[key] = {
            relativePath,
            exists:
                retrievedPathSet.has(relativePath) ||
                (await pathExists(path.join(workspacePath, relativePath)))
        };
    }

    return checks;
}

function buildRetrieveDiagnosticRecord({
    metadataType,
    metadataName,
    alias,
    workspacePath,
    retrieveCommand,
    sourceApiVersion,
    exitCode,
    stdout,
    stderr,
    summary,
    retrievedFiles,
    workspaceTopLevel,
    expectedPathChecks
}) {
    const failureMessages = extractCliFailureMessages(summary, stderr);

    return {
        metadataType,
        metadataName,
        alias,
        workspacePath,
        sourceApiVersion: sourceApiVersion || null,
        retrieveCommand: redactDiagnosticText(retrieveCommand),
        exitCode: exitCode ?? null,
        stdoutLength: String(stdout || '').length,
        stderrLength: String(stderr || '').length,
        cliParsed: summary?.parsed === true,
        cliStatus: summary?.parsed ? summary.status ?? null : null,
        cliFailureCount: summary?.parsed ? summary.failureCount ?? 0 : 0,
        cliFailureMessages: failureMessages,
        stderrSnippet: stderr
            ? redactDiagnosticText(stderr)
            : null,
        retrievedFileCount: retrievedFiles.length,
        retrievedFilePaths: retrievedFiles.map((file) => file.relativePath),
        workspaceTopLevel,
        expectedSourcePaths: expectedPathChecks
    };
}

function logDestinationRetrieveDiagnostic(diagnostic) {
    logSection('Destination Snapshot Retrieve Diagnostic');
    console.log(JSON.stringify(diagnostic, null, 2));
}

function buildExecFailureError(metadataType, metadataName, diagnostic) {
    const prefix = `Destination snapshot capture failed for ${metadataType}:${metadataName}:`;
    const details = [];

    if (diagnostic.exitCode != null) {
        details.push(`exit code ${diagnostic.exitCode}`);
    }

    if (diagnostic.cliStatus != null) {
        details.push(`CLI status ${diagnostic.cliStatus}`);
    }

    if (diagnostic.cliFailureMessages?.length) {
        details.push(diagnostic.cliFailureMessages.join('; '));
    } else if (diagnostic.stderrSnippet) {
        details.push(diagnostic.stderrSnippet);
    } else {
        details.push('retrieve command failed');
    }

    return new Error(`${prefix} ${details.join(' — ')}`);
}

function buildZeroFilesError(metadataType, metadataName, diagnostic) {
    const prefix = `Destination snapshot capture failed for ${metadataType}:${metadataName}:`;
    const details = [
        'retrieve completed but zero files were collected from workspace',
        `retrieved file count = 0`
    ];

    if (diagnostic.cliStatus != null) {
        details.push(`CLI status ${diagnostic.cliStatus}`);
    }

    if (diagnostic.workspaceTopLevel?.length) {
        details.push(
            `workspace entries: ${diagnostic.workspaceTopLevel.join(', ')}`
        );
    } else {
        details.push('workspace entries: (empty)');
    }

    if (diagnostic.cliFailureMessages?.length) {
        details.push(
            `CLI failures: ${diagnostic.cliFailureMessages.join('; ')}`
        );
    }

    if (diagnostic.expectedSourcePaths) {
        const expectedSummary = Object.entries(diagnostic.expectedSourcePaths)
            .map(
                ([key, value]) =>
                    `${key}=${value.exists ? 'found' : 'missing'} (${value.relativePath})`
            )
            .join(', ');
        details.push(`expected source paths: ${expectedSummary}`);
    }

    return new Error(`${prefix} ${details.join(' — ')}`);
}

async function collectProjectFiles(rootPath, currentPath = rootPath, acc = []) {
    if (!(await pathExists(currentPath))) {
        return acc;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
        const absolutePath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) {
                continue;
            }

            await collectProjectFiles(rootPath, absolutePath, acc);
            continue;
        }

        if (SKIP_FILE_NAMES.has(entry.name)) {
            continue;
        }

        const relativePath = path
            .relative(rootPath, absolutePath)
            .replace(/\\/g, '/');
        const bytes = await readFile(absolutePath);

        acc.push({ relativePath, bytes });
    }

    return acc;
}

async function logoutAlias(alias, execAsync) {
    if (!alias) {
        return;
    }

    try {
        await execAsync(
            `sf org logout --target-org ${shellQuote(alias)} --noprompt`
        );
    } catch (error) {
        console.warn(
            'Destination snapshot retrieve logout failed:',
            error.message || error
        );
    }
}

async function deleteWorkspace(workspacePath, rmFn) {
    if (!workspacePath) {
        return;
    }

    try {
        if (await pathExists(workspacePath)) {
            await rmFn(workspacePath, { recursive: true, force: true });
        }
    } catch (error) {
        console.warn(
            'Destination snapshot retrieve workspace cleanup failed:',
            error.message || error
        );
    }
}

function buildRetrieveCommand({
    projectPath,
    alias,
    metadataType,
    metadataName
}) {
    const member = `${metadataType}:${metadataName}`;

    return (
        `cd ${shellQuote(projectPath)} && ` +
        `sf project retrieve start ` +
        `--target-org ${shellQuote(alias)} ` +
        `-m ${shellQuote(member)} ` +
        `--json`
    );
}

function createDestinationMetadataRetriever(dependencies = {}) {
    const execAsync = dependencies.execAsync || defaultExecAsync;
    const refreshTokenFn = dependencies.refreshAccessToken || refreshAccessToken;
    const loginFn = dependencies.loginSfOrg || loginSfOrg;
    const ensureProjectFn = dependencies.ensureSfdxProject || ensureSfdxProject;
    const mkdirFn = dependencies.mkdir || mkdir;
    const rmFn = dependencies.rm || rm;
    const tmpdirFn = dependencies.tmpdir || os.tmpdir;

    async function retrieveDestinationMember({
        refreshToken,
        instanceUrl,
        metadataType,
        metadataName,
        sourceApiVersion
    }) {
        if (!refreshToken || !instanceUrl) {
            throw new Error(
                `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
                    'missing destination org credentials.'
            );
        }

        if (!metadataType || !metadataName) {
            throw new Error(
                'Destination snapshot capture failed: metadata identity is required.'
            );
        }

        const workspacePath = path.join(
            tmpdirFn(),
            `dest-snapshot-${crypto.randomUUID()}`
        );
        const alias = `dest-snapshot-${Date.now()}`;
        let retrievedFiles = [];

        try {
            logSection('Destination Snapshot Retrieve Started');
            console.log(`Member: ${metadataType}:${metadataName}`);

            await mkdirFn(workspacePath, { recursive: true });

            const bootstrap = await ensureProjectFn(workspacePath, {
                sourceApiVersion
            });

            if (!bootstrap?.success) {
                throw new Error(
                    `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
                        'unable to create isolated retrieve project.'
                );
            }

            const tokenResult = await refreshTokenFn(refreshToken);
            await loginFn(
                tokenResult.accessToken,
                tokenResult.instanceUrl || instanceUrl,
                alias
            );

            const command = buildRetrieveCommand({
                projectPath: workspacePath,
                alias,
                metadataType,
                metadataName
            });

            let cliStdout = '';
            let cliStderr = '';
            let exitCode = 0;
            let cliSummary = summarizeRetrieveCliOutput('');

            try {
                const commandResult = await execAsync(command, {
                    maxBuffer: 50 * 1024 * 1024
                });

                cliStdout = commandResult.stdout || '';
                cliStderr = commandResult.stderr || '';
                exitCode = 0;
                cliSummary = summarizeRetrieveCliOutput(cliStdout);
            } catch (error) {
                exitCode = typeof error.code === 'number' ? error.code : 1;
                cliStdout = error.stdout || '';
                cliStderr = error.stderr || error.message || '';
                cliSummary = summarizeRetrieveCliOutput(cliStdout);

                const diagnostic = buildRetrieveDiagnosticRecord({
                    metadataType,
                    metadataName,
                    alias,
                    workspacePath,
                    retrieveCommand: command,
                    sourceApiVersion:
                        bootstrap?.sourceApiVersion || sourceApiVersion || null,
                    exitCode,
                    stdout: cliStdout,
                    stderr: cliStderr,
                    summary: cliSummary,
                    retrievedFiles: [],
                    workspaceTopLevel: await listWorkspaceTopLevel(workspacePath),
                    expectedPathChecks: await buildExpectedPathChecks({
                        workspacePath,
                        metadataType,
                        metadataName,
                        retrievedFiles: []
                    })
                });

                logDestinationRetrieveDiagnostic(diagnostic);
                throw buildExecFailureError(
                    metadataType,
                    metadataName,
                    diagnostic
                );
            }

            retrievedFiles = await collectProjectFiles(workspacePath);

            const diagnostic = buildRetrieveDiagnosticRecord({
                metadataType,
                metadataName,
                alias,
                workspacePath,
                retrieveCommand: command,
                sourceApiVersion:
                    bootstrap?.sourceApiVersion || sourceApiVersion || null,
                exitCode,
                stdout: cliStdout,
                stderr: cliStderr,
                summary: cliSummary,
                retrievedFiles,
                workspaceTopLevel: await listWorkspaceTopLevel(workspacePath),
                expectedPathChecks: await buildExpectedPathChecks({
                    workspacePath,
                    metadataType,
                    metadataName,
                    retrievedFiles
                })
            });

            logDestinationRetrieveDiagnostic(diagnostic);

            if (!retrievedFiles.length) {
                throw buildZeroFilesError(
                    metadataType,
                    metadataName,
                    diagnostic
                );
            }

            return {
                files: retrievedFiles,
                artifactBytes: packMemberFiles(retrievedFiles)
            };
        } finally {
            await logoutAlias(alias, execAsync);
            await deleteWorkspace(workspacePath, rmFn);
            logSection('Destination Snapshot Retrieve Cleanup Complete');
        }
    }

    return {
        retrieveDestinationMember,
        buildRetrieveCommand,
        collectProjectFiles,
        deleteWorkspace
    };
}

const defaultRetriever = createDestinationMetadataRetriever();

module.exports = {
    createDestinationMetadataRetriever,
    retrieveDestinationMember: defaultRetriever.retrieveDestinationMember,
    buildRetrieveCommand: defaultRetriever.buildRetrieveCommand,
    buildExpectedMemberSourcePaths,
    summarizeRetrieveCliOutput,
    redactDiagnosticText,
    buildRetrieveDiagnosticRecord,
    logDestinationRetrieveDiagnostic
};
