'use strict';

const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function getAuthenticatedRepoUrl(repoUrl) {
    const githubToken = process.env.GITHUB_TOKEN;

    if (!githubToken || !repoUrl?.startsWith('https://')) {
        return repoUrl;
    }

    return repoUrl.replace('https://', `https://${githubToken}@`);
}

async function runGit(cwd, args, options = {}) {
    const command = `git ${args}`;

    return execAsync(command, {
        cwd,
        maxBuffer: 50 * 1024 * 1024,
        ...options
    });
}

function classifyExecError(error) {
    const combined = `${error.stderr || ''}\n${error.message || ''}`.toLowerCase();

    if (
        /authentication failed|invalid username|403|401|permission denied|access denied/.test(
            combined
        )
    ) {
        return 'auth';
    }

    if (
        /could not resolve host|network is unreachable|connection timed out|econnrefused|enotfound|timeout/.test(
            combined
        )
    ) {
        return 'network';
    }

    return 'fetch';
}

module.exports = {
    shellQuote,
    getAuthenticatedRepoUrl,
    runGit,
    classifyExecError,
    execAsync
};
