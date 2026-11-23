'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const { exec } = require('child_process');

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    withFetchedRepository,
    revParseOriginHead,
    showBlobAtRef,
    shellQuote,
    getAuthenticatedRepoUrl
} = require('./apexMergeGit.service');
const {
    validateMethodUnitForSeal,
    METHOD_MERGE_MODE
} = require('./apexMergeMethodSession.service');

const execAsync = util.promisify(exec);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

const PUBLISH_STATE = Object.freeze({
    PUBLISHED: 'PUBLISHED'
});

const GIT_PUBLISH_USER_EMAIL = 'backup@system.com';
const GIT_PUBLISH_USER_NAME = 'Salesforce Backup Bot';

function sanitizeGitStderr(stderr) {
    return String(stderr || '')
        .replace(/https?:\/\/[^@\s]+@/gi, 'https://***@')
        .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:***@')
        .slice(0, 2000);
}

function logMethodPublishGitFailure(code, message, cause) {
    console.error(
        JSON.stringify({
            event: 'apex_merge_method_publish_git_failure',
            code,
            message,
            gitStderr: sanitizeGitStderr(cause)
        })
    );
}

async function configureLocalGitIdentity(repoPath, git = runGit) {
    await git(repoPath, `config user.email ${shellQuote(GIT_PUBLISH_USER_EMAIL)}`);
    await git(repoPath, `config user.name ${shellQuote(GIT_PUBLISH_USER_NAME)}`);
}

function sha256Utf8(content) {
    return crypto
        .createHash('sha256')
        .update(String(content ?? ''), 'utf8')
        .digest('hex');
}

function normalizeBranchRef(branch) {
    return String(branch || '').replace(/^origin\//, '');
}

async function runGit(repoPath, command, options = {}) {
    const normalizedCommand = String(command || '').trim().startsWith('git ')
        ? String(command).trim()
        : `git ${String(command || '').trim()}`;

    const result = await execAsync(
        `cd ${shellQuote(repoPath)} && ${normalizedCommand}`,
        { maxBuffer: 20 * 1024 * 1024, ...options }
    );

    return result.stdout;
}

function resolveInputMergePins(session) {
    if (session.inputMergePins?.sourceHeadSha) {
        return {
            sourceHeadSha: session.inputMergePins.sourceHeadSha,
            destinationHeadSha: session.inputMergePins.destinationHeadSha
        };
    }

    return {
        sourceHeadSha: session.gitPins?.sourceHeadSha,
        destinationHeadSha: session.gitPins?.destinationHeadSha
    };
}

function assertPublishableMethodUnit(unit, metadataName) {
    if (!unit) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            `metadataName ${metadataName} is not part of this merge session.`
        );
    }

    if (unit.mergeMode !== METHOD_MERGE_MODE) {
        throw new ApexMergeError(
            MERGE_ERROR.PUBLISH_NOT_ELIGIBLE,
            `Class ${metadataName} is not in METHOD merge mode.`,
            { metadataName, mergeMode: unit.mergeMode }
        );
    }

    validateMethodUnitForSeal(unit);
}

function selectPublishUnits(session, metadataNames) {
    const uniqueNames = [
        ...new Set(
            metadataNames.map((name) => String(name || '').trim()).filter(Boolean)
        )
    ];

    if (!uniqueNames.length) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'metadataNames must include at least one Apex class.'
        );
    }

    const units = [];

    for (const metadataName of uniqueNames) {
        const unit = (session.classes || []).find(
            (entry) => entry.metadataName === metadataName
        );

        assertPublishableMethodUnit(unit, metadataName);

        const clsContent = unit.artifacts?.cls?.content;

        units.push({
            metadataName,
            filePath: unit.filePath,
            metaXmlPath: unit.metaXmlPath,
            clsContent,
            clsSha256:
                unit.artifacts?.cls?.sha256 || sha256Utf8(clsContent)
        });
    }

    return units;
}

async function readRemoteBranchHeads(repoPath, sourceBranch, destinationBranch) {
    const sourceHeadSha = await revParseOriginHead(repoPath, sourceBranch);
    const destinationHeadSha = await revParseOriginHead(
        repoPath,
        destinationBranch
    );

    return { sourceHeadSha, destinationHeadSha };
}

function assertImmutableBranchPins(current, inputMergePins) {
    if (current.sourceHeadSha !== inputMergePins.sourceHeadSha) {
        throw new ApexMergeError(
            MERGE_ERROR.PUBLISH_SOURCE_BRANCH_CHANGED,
            'Source branch HEAD changed since merge session creation; publish aborted.',
            {
                expected: inputMergePins.sourceHeadSha,
                actual: current.sourceHeadSha
            }
        );
    }

    if (current.destinationHeadSha !== inputMergePins.destinationHeadSha) {
        throw new ApexMergeError(
            MERGE_ERROR.PUBLISH_DESTINATION_BRANCH_CHANGED,
            'Destination branch HEAD changed since merge session creation; publish aborted.',
            {
                expected: inputMergePins.destinationHeadSha,
                actual: current.destinationHeadSha
            }
        );
    }
}

async function remoteClsMatchesPublishUnit(
    repoPath,
    ref,
    unit
) {
    const blob = await showBlobAtRef(repoPath, ref, unit.filePath);

    if (!blob.exists) {
        return false;
    }

    return sha256Utf8(blob.content) === unit.clsSha256;
}

async function tryIdempotentPublish({
    repoPath,
    sourceBranch,
    publishUnits,
    existingPublish
}) {
    if (existingPublish?.publishState !== PUBLISH_STATE.PUBLISHED) {
        return null;
    }

    const publishedCommitSha = existingPublish.publishedCommitSha;

    if (!publishedCommitSha) {
        return null;
    }

    const sourceRef = `origin/${normalizeBranchRef(sourceBranch)}`;
    const remoteHead = await revParseOriginHead(repoPath, sourceBranch);

    if (remoteHead !== publishedCommitSha) {
        return null;
    }

    for (const unit of publishUnits) {
        const matches = await remoteClsMatchesPublishUnit(
            repoPath,
            publishedCommitSha,
            unit
        );

        if (!matches) {
            return null;
        }
    }

    return {
        publishState: PUBLISH_STATE.PUBLISHED,
        publishedCommitSha,
        publishedAt: existingPublish.publishedAt,
        publishedClasses: existingPublish.publishedClasses
    };
}

async function checkoutSourceAtPin(
    repoPath,
    sourceBranch,
    sourceHeadSha,
    git = runGit
) {
    const branch = normalizeBranchRef(sourceBranch);

    await git(repoPath, 'fetch origin');
    await git(
        repoPath,
        `checkout -B ${shellQuote(branch)} ${shellQuote(sourceHeadSha)}`
    );
}

function assertCommandDoesNotForcePush(command) {
    if (/--force\b|-f\b/.test(String(command))) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'Force push is not permitted for Apex merge publish.'
        );
    }
}

async function reconcilePushOutcome({
    repoPath,
    sourceBranch,
    publishUnits,
    localHeadSha,
    runGit: git = runGit
}) {
    await git(repoPath, 'fetch origin');

    const remoteHead = await revParseOriginHead(repoPath, sourceBranch);

    if (remoteHead !== localHeadSha) {
        return null;
    }

    for (const unit of publishUnits) {
        const matches = await remoteClsMatchesPublishUnit(
            repoPath,
            remoteHead,
            unit
        );

        if (!matches) {
            return null;
        }
    }

    return remoteHead;
}

/**
 * Publish composed METHOD-merge classes to the Source branch inside an existing clone.
 */
async function publishMethodMergeInRepo({
    repoPath,
    sourceBranch,
    destinationBranch,
    inputMergePins,
    publishUnits,
    existingPublish = null,
    deps = {}
} = {}) {
    const git = deps.runGit || runGit;
    if (!repoPath || !sourceBranch || !inputMergePins || !publishUnits?.length) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'repoPath, sourceBranch, inputMergePins, and publishUnits are required.'
        );
    }

    await git(repoPath, 'fetch origin');

    const remoteBefore = await readRemoteBranchHeads(
        repoPath,
        sourceBranch,
        destinationBranch
    );

    const idempotent = await tryIdempotentPublish({
        repoPath,
        sourceBranch,
        publishUnits,
        existingPublish
    });

    if (idempotent) {
        return idempotent;
    }

    assertImmutableBranchPins(remoteBefore, inputMergePins);

    const allAlreadyOnSourceTip = await publishUnits.reduce(
        async (promise, unit) => {
            const prior = await promise;
            if (!prior) {
                return false;
            }

            return remoteClsMatchesPublishUnit(
                repoPath,
                remoteBefore.sourceHeadSha,
                unit
            );
        },
        Promise.resolve(true)
    );

    if (allAlreadyOnSourceTip) {
        return {
            publishState: PUBLISH_STATE.PUBLISHED,
            publishedCommitSha: remoteBefore.sourceHeadSha,
            publishedAt: new Date().toISOString(),
            publishedClasses: publishUnits.map((unit) => ({
                metadataName: unit.metadataName,
                filePath: unit.filePath
            }))
        };
    }

    const metaSnapshots = new Map();

    await checkoutSourceAtPin(
        repoPath,
        sourceBranch,
        inputMergePins.sourceHeadSha,
        git
    );

    for (const unit of publishUnits) {
        const absoluteCls = path.join(repoPath, unit.filePath);
        const absoluteMeta = path.join(
            repoPath,
            unit.metaXmlPath || `${unit.filePath}-meta.xml`
        );

        await mkdir(path.dirname(absoluteCls), { recursive: true });

        if (unit.metaXmlPath) {
            try {
                metaSnapshots.set(
                    unit.metadataName,
                    await readFile(absoluteMeta, 'utf8')
                );
            } catch (error) {
                metaSnapshots.set(unit.metadataName, null);
            }
        }

        await writeFile(absoluteCls, unit.clsContent, 'utf8');
    }

    await configureLocalGitIdentity(repoPath, git);

    const stagedPaths = publishUnits
        .map((unit) => shellQuote(unit.filePath.replace(/\\/g, '/')))
        .join(' ');

    await git(repoPath, `add -- ${stagedPaths}`);

    const classNames = publishUnits.map((unit) => unit.metadataName).join(', ');
    const commitMessage = `Apex METHOD merge publish (${classNames})`;

    await git(
        repoPath,
        `commit -m ${shellQuote(commitMessage)}`,
        { maxBuffer: 50 * 1024 * 1024 }
    ).catch((error) => {
        if (String(error.stderr || '').includes('nothing to commit')) {
            throw new ApexMergeError(
                MERGE_ERROR.PUBLISH_NOT_ELIGIBLE,
                'No publishable .cls changes detected.',
                { cause: error.stderr || error.message }
            );
        }

        logMethodPublishGitFailure(
            MERGE_ERROR.GIT_ERROR,
            'Git commit failed.',
            error.stderr || error.message
        );

        throw new ApexMergeError(MERGE_ERROR.GIT_ERROR, 'Git commit failed.', {
            cause: error.stderr || error.message
        });
    });

    for (const unit of publishUnits) {
        if (!unit.metaXmlPath) {
            continue;
        }

        const absoluteMeta = path.join(repoPath, unit.metaXmlPath);
        const before = metaSnapshots.get(unit.metadataName);
        const after = await readFile(absoluteMeta, 'utf8');

        if (before !== null && before !== after) {
            throw new ApexMergeError(
                MERGE_ERROR.PUBLISH_NOT_ELIGIBLE,
                `Companion metadata changed unexpectedly for ${unit.metadataName}.`,
                { metadataName: unit.metadataName }
            );
        }
    }

    const localHeadSha = (await git(repoPath, 'rev-parse HEAD')).trim();

    await git(repoPath, 'fetch origin');

    const remoteAfterFetch = await readRemoteBranchHeads(
        repoPath,
        sourceBranch,
        destinationBranch
    );
    assertImmutableBranchPins(remoteAfterFetch, inputMergePins);

    const branch = normalizeBranchRef(sourceBranch);
    const pushCommand = `push origin ${shellQuote(branch)}`;
    assertCommandDoesNotForcePush(pushCommand);

    try {
        await git(repoPath, pushCommand);
    } catch (error) {
        const reconciledSha = await reconcilePushOutcome({
            repoPath,
            sourceBranch,
            publishUnits,
            localHeadSha,
            runGit: git
        }).catch(() => null);

        if (reconciledSha) {
            return {
                publishState: PUBLISH_STATE.PUBLISHED,
                publishedCommitSha: reconciledSha,
                publishedAt: new Date().toISOString(),
                publishedClasses: publishUnits.map((unit) => ({
                    metadataName: unit.metadataName,
                    filePath: unit.filePath
                }))
            };
        }

        logMethodPublishGitFailure(
            MERGE_ERROR.PUBLISH_PUSH_REJECTED,
            'Git push to Source branch was rejected.',
            error.stderr || error.message
        );

        throw new ApexMergeError(
            MERGE_ERROR.PUBLISH_PUSH_REJECTED,
            'Git push to Source branch was rejected.',
            { cause: error.stderr || error.message }
        );
    }

    const publishedCommitSha = (await git(repoPath, 'rev-parse HEAD')).trim();

    const remoteHeadAfterPush = await revParseOriginHead(repoPath, sourceBranch);
    const destinationAfterPush = await revParseOriginHead(
        repoPath,
        destinationBranch
    );

    if (destinationAfterPush !== inputMergePins.destinationHeadSha) {
        throw new ApexMergeError(
            MERGE_ERROR.PUBLISH_DESTINATION_BRANCH_CHANGED,
            'Destination branch changed during publish.',
            {
                expected: inputMergePins.destinationHeadSha,
                actual: destinationAfterPush
            }
        );
    }

    if (remoteHeadAfterPush !== publishedCommitSha) {
        throw new ApexMergeError(
            MERGE_ERROR.GIT_ERROR,
            'Published commit SHA does not match remote Source branch HEAD after push.',
            { expected: publishedCommitSha, actual: remoteHeadAfterPush }
        );
    }

    return {
        publishState: PUBLISH_STATE.PUBLISHED,
        publishedCommitSha,
        publishedAt: new Date().toISOString(),
        publishedClasses: publishUnits.map((unit) => ({
            metadataName: unit.metadataName,
            filePath: unit.filePath
        }))
    };
}

async function publishMethodMergeSession(session, metadataNames) {
    const inputMergePins = resolveInputMergePins(session);
    const publishUnits = selectPublishUnits(session, metadataNames);

    if (
        !inputMergePins.sourceHeadSha ||
        !inputMergePins.destinationHeadSha
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'Merge session is missing immutable input merge pins.'
        );
    }

    const publishResult = await withFetchedRepository(
        session.repoUrl,
        async ({ repoPath }) =>
            publishMethodMergeInRepo({
                repoPath,
                sourceBranch: session.sourceBranch,
                destinationBranch: session.destinationBranch,
                inputMergePins,
                publishUnits,
                existingPublish: session.publish || null
            })
    );

    return {
        ...publishResult,
        inputMergePins
    };
}

module.exports = {
    PUBLISH_STATE,
    GIT_PUBLISH_USER_EMAIL,
    GIT_PUBLISH_USER_NAME,
    sha256Utf8,
    resolveInputMergePins,
    selectPublishUnits,
    publishMethodMergeInRepo,
    publishMethodMergeSession,
    assertImmutableBranchPins,
    assertCommandDoesNotForcePush,
    configureLocalGitIdentity,
    runGit,
    normalizeBranchRef,
    getAuthenticatedRepoUrl,
    sanitizeGitStderr,
    logMethodPublishGitFailure
};