'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');

const execAsync = util.promisify(exec);
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const rm = util.promisify(fs.rm);

const CONFLICT_MARKER_PATTERN = /^<{7}|^={7}|^>{7}/m;

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

async function removeDirectory(targetPath) {
    if (!targetPath) {
        return;
    }

    try {
        if (process.platform === 'win32') {
            await execAsync(`rmdir /s /q ${shellQuote(targetPath)}`);
        } else {
            await rm(targetPath, { recursive: true, force: true });
        }
    } catch (error) {
        // best effort
    }
}

/**
 * @param {string} repoUrl
 * @param {(ctx: { repoPath: string }) => Promise<T>} callback
 */
async function withFetchedRepository(repoUrl, callback) {
    const repoPath = path.join(os.tmpdir(), `apex-merge-git-${Date.now()}`);
    const authenticatedUrl = getAuthenticatedRepoUrl(repoUrl);

    try {
        await mkdir(path.dirname(repoPath), { recursive: true });
        await execAsync(
            `git clone ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );
        await execAsync(
            `cd ${shellQuote(repoPath)} && git config core.autocrlf false`
        );
        await execAsync(`cd ${shellQuote(repoPath)} && git fetch --all`);

        return await callback({ repoPath });
    } finally {
        await removeDirectory(repoPath);
    }
}

async function revParseOriginHead(repoPath, branch) {
    const branchRef = String(branch || '').replace(/^origin\//, '');
    const result = await execAsync(
        `cd ${shellQuote(repoPath)} && git rev-parse ${shellQuote(`origin/${branchRef}`)}`
    );

    return result.stdout.trim();
}

async function mergeBaseSha(repoPath, sourceBranch, destinationBranch) {
    const sourceRef = String(sourceBranch || '').replace(/^origin\//, '');
    const destRef = String(destinationBranch || '').replace(/^origin\//, '');

    try {
        const result = await execAsync(
            `cd ${shellQuote(repoPath)} && git merge-base ${shellQuote(`origin/${destRef}`)} ${shellQuote(`origin/${sourceRef}`)}`
        );
        const sha = result.stdout.trim();

        if (!sha) {
            throw new ApexMergeError(
                MERGE_ERROR.NO_COMMON_ANCESTOR,
                'No common ancestor between source and destination branches.'
            );
        }

        return sha;
    } catch (error) {
        if (error instanceof ApexMergeError) {
            throw error;
        }

        throw new ApexMergeError(
            MERGE_ERROR.NO_COMMON_ANCESTOR,
            'No common ancestor between source and destination branches.',
            { cause: error.stderr || error.message }
        );
    }
}

async function showBlobAtRef(repoPath, ref, filePath) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/');

  try {
      const result = await execAsync(
          `cd ${shellQuote(repoPath)} && git show ${shellQuote(`${ref}:${normalizedPath}`)}`
      );

      return { exists: true, content: result.stdout };
  } catch (error) {
      return { exists: false, content: null };
  }
}

function hasConflictMarkers(content) {
    return CONFLICT_MARKER_PATTERN.test(String(content || ''));
}

/**
 * Three-way text merge: current=destination, base=ancestor, other=source (git merge-file convention).
 * @returns {{ content: string, conflict: boolean }}
 */
async function threeWayMergeText({ current, base, other } = {}) {
    const tempDir = path.join(
        os.tmpdir(),
        `apex-merge-file-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const currentPath = path.join(tempDir, 'current');
    const basePath = path.join(tempDir, 'base');
    const otherPath = path.join(tempDir, 'other');

    await mkdir(tempDir, { recursive: true });
    await writeFile(currentPath, current ?? '', 'utf8');
    await writeFile(basePath, base ?? '', 'utf8');
    await writeFile(otherPath, other ?? '', 'utf8');

    try {
        const result = await execAsync(
            `git merge-file -p ${shellQuote(currentPath)} ${shellQuote(basePath)} ${shellQuote(otherPath)}`,
            { maxBuffer: 10 * 1024 * 1024 }
        );

        const content = result.stdout;

        return {
            content,
            conflict: hasConflictMarkers(content)
        };
    } catch (error) {
        const merged =
            error.stdout ||
            (error.code === 1 && (await readFileSafe(currentPath)));

        const content = merged || '';
        const conflict =
            hasConflictMarkers(content) || error.code === 1;

        if (conflict) {
            return { content, conflict: true };
        }

        throw new ApexMergeError(
            MERGE_ERROR.GIT_ERROR,
            'Git merge-file failed.',
            { cause: error.stderr || error.message }
        );
    } finally {
        await removeDirectory(tempDir);
    }
}

async function readFileSafe(filePath) {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error) {
        return '';
    }
}

async function collectBranchHeads(repoPath, sourceBranch, destinationBranch) {
    const [sourceHeadSha, destinationHeadSha] = await Promise.all([
        revParseOriginHead(repoPath, sourceBranch),
        revParseOriginHead(repoPath, destinationBranch)
    ]);

    return { sourceHeadSha, destinationHeadSha };
}

module.exports = {
    withFetchedRepository,
    revParseOriginHead,
    mergeBaseSha,
    showBlobAtRef,
    threeWayMergeText,
    hasConflictMarkers,
    collectBranchHeads,
    getAuthenticatedRepoUrl,
    shellQuote
};
