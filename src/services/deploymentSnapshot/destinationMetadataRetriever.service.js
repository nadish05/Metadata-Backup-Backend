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

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
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

            try {
                await execAsync(command, { maxBuffer: 50 * 1024 * 1024 });
            } catch (error) {
                const cliOutput = error.stdout || error.stderr || '';
                void cliOutput;
                throw new Error(
                    `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
                        'member retrieval returned no artifact.'
                );
            }

            retrievedFiles = await collectProjectFiles(workspacePath);

            if (!retrievedFiles.length) {
                throw new Error(
                    `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
                        'member retrieval returned no artifact.'
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
    buildRetrieveCommand: defaultRetriever.buildRetrieveCommand
};
