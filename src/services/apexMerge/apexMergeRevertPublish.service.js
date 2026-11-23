'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    withFetchedRepository,
    revParseOriginHead,
    showBlobAtRef,
    shellQuote
} = require('./apexMergeGit.service');
const {
    PUBLISH_STATE,
    sha256Utf8,
    resolveInputMergePins,
    selectPublishUnits,
    configureLocalGitIdentity,
    runGit,
    normalizeBranchRef,
    assertCommandDoesNotForcePush,
    logMethodPublishGitFailure
} = require('./apexMergePublish.service');

const { writeFile, mkdir, readFile } = {
    writeFile: util.promisify(fs.writeFile),
    mkdir: util.promisify(fs.mkdir),
    readFile: util.promisify(fs.readFile)
};

const REVERT_STATE = Object.freeze({
    REVERTED: 'REVERTED',
    IN_PROGRESS: 'IN_PROGRESS'
});

function buildRevertUnits(session) {
    const publish = session.publish;

    if (!publish || publish.publishState !== PUBLISH_STATE.PUBLISHED) {
        throw new ApexMergeError(
            MERGE_ERROR.REVERT_NOT_ELIGIBLE,
            'Merge session has not been successfully published.',
            { publishState: publish?.publishState ?? null }
        );
    }

    const publishedClasses = publish.publishedClasses || [];

    if (!publishedClasses.length) {
        throw new ApexMergeError(
            MERGE_ERROR.REVERT_NOT_ELIGIBLE,
            'Published class list is missing from the merge session.'
        );
    }

    const publishedCommitSha = publish.publishedCommitSha;

    if (!publishedCommitSha) {
        throw new ApexMergeError(
            MERGE_ERROR.REVERT_NOT_ELIGIBLE,
            'Published commit SHA is missing from the merge session.'
        );
    }

    const units = [];

    for (const entry of publishedClasses) {
        const unit = (session.classes || []).find(
            (row) => row.metadataName === entry.metadataName
        );

        if (!unit) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `metadataName ${entry.metadataName} is not part of this merge session.`
            );
        }

        const clsContent = unit.artifacts?.cls?.content;
        const publishedClsSha256 =
            unit.artifacts?.cls?.sha256 || (clsContent ? sha256Utf8(clsContent) : null);

        if (!publishedClsSha256) {
            throw new ApexMergeError(
                MERGE_ERROR.REVERT_NOT_ELIGIBLE,
                `Class ${entry.metadataName} is missing published content hash.`
            );
        }

        units.push({
            metadataName: entry.metadataName,
            filePath: entry.filePath,
            metaXmlPath: unit.metaXmlPath,
            publishedClsSha256,
            clsContent
        });
    }

    return {
        publishedCommitSha,
        publishedAt: publish.publishedAt,
        units
    };
}

async function resolveParentSha(repoPath, commitSha, git = runGit) {
    const parent = (await git(repoPath, `rev-parse ${shellQuote(`${commitSha}^`)}`)).trim();

    if (!parent) {
        throw new ApexMergeError(
            MERGE_ERROR.REVERT_HISTORY_DIVERGED,
            'Unable to resolve parent of published commit.',
            { publishedCommitSha: commitSha }
        );
    }

    return parent;
}

async function isAncestor(repoPath, ancestorSha, descendantSha, git = runGit) {
    try {
        await git(
            repoPath,
            `merge-base --is-ancestor ${shellQuote(ancestorSha)} ${shellQuote(descendantSha)}`
        );
        return true;
    } catch (error) {
        return false;
    }
}

async function checkoutSourceAtHead(
    repoPath,
    sourceBranch,
    headSha,
    git = runGit
) {
    const branch = normalizeBranchRef(sourceBranch);

    await git(repoPath, 'fetch origin');
    await git(
        repoPath,
        `checkout -B ${shellQuote(branch)} ${shellQuote(headSha)}`
    );
}

function remoteBlobMatchesSha(repoPath, ref, unit) {
    return showBlobAtRef(repoPath, ref, unit.filePath).then((blob) => {
        if (!blob.exists) {
            return false;
        }

        return sha256Utf8(blob.content) === unit.publishedClsSha256;
    });
}

async function remoteMatchesPrePublishBlob(repoPath, prePublishSha, unit) {
    const blob = await showBlobAtRef(repoPath, prePublishSha, unit.filePath);

    if (!blob.exists) {
        return { matches: false, content: null, sha256: null };
    }

    const hash = sha256Utf8(blob.content);
    return { matches: true, content: blob.content, sha256: hash };
}

async function tryIdempotentRevert({
    repoPath,
    sourceBranch,
    revertUnits,
    prePublishSha,
    existingRevert
}) {
    if (existingRevert?.revertState !== REVERT_STATE.REVERTED) {
        return null;
    }

    const remoteHead = await revParseOriginHead(repoPath, sourceBranch);

    for (const unit of revertUnits) {
        const atHead = await remoteMatchesPrePublishBlob(
            repoPath,
            remoteHead,
            unit
        );
        const pre = await remoteMatchesPrePublishBlob(
            repoPath,
            prePublishSha,
            unit
        );

        if (!atHead.matches || !pre.matches || atHead.sha256 !== pre.sha256) {
            return null;
        }
    }

    return {
        revertState: REVERT_STATE.REVERTED,
        revertCommitSha:
            existingRevert.revertCommitSha ||
            (existingRevert.noGitCommit ? null : remoteHead),
        revertedAt: existingRevert.revertedAt,
        revertedClasses: existingRevert.revertedClasses,
        noGitCommit: existingRevert.noGitCommit === true
    };
}

async function reconcileRevertPushOutcome({
    repoPath,
    sourceBranch,
    revertUnits,
    prePublishSha,
    localHeadSha,
    git = runGit
}) {
    await git(repoPath, 'fetch origin');

    const remoteHead = await revParseOriginHead(repoPath, sourceBranch);

    if (remoteHead !== localHeadSha) {
        return null;
    }

    for (const unit of revertUnits) {
        const atHead = await remoteMatchesPrePublishBlob(
            repoPath,
            remoteHead,
            unit
        );
        const pre = await remoteMatchesPrePublishBlob(
            repoPath,
            prePublishSha,
            unit
        );

        if (!atHead.matches || !pre.matches || atHead.sha256 !== pre.sha256) {
            return null;
        }
    }

    return remoteHead;
}

async function assertPublishedFilesUnchanged(repoPath, remoteHead, revertUnits) {
    for (const unit of revertUnits) {
        const matchesPublished = await remoteBlobMatchesSha(
            repoPath,
            remoteHead,
            {
                filePath: unit.filePath,
                publishedClsSha256: unit.publishedClsSha256
            }
        );

        if (!matchesPublished) {
            throw new ApexMergeError(
                MERGE_ERROR.REVERT_SOURCE_FILE_DRIFT,
                `Published Apex file ${unit.metadataName} changed on the Source branch; revert refused.`,
                {
                    metadataName: unit.metadataName,
                    filePath: unit.filePath,
                    remoteHead
                }
            );
        }
    }
}

async function alreadyAtPrePublishContent(repoPath, remoteHead, prePublishSha, revertUnits) {
    for (const unit of revertUnits) {
        const atHead = await remoteMatchesPrePublishBlob(
            repoPath,
            remoteHead,
            unit
        );
        const pre = await remoteMatchesPrePublishBlob(
            repoPath,
            prePublishSha,
            unit
        );

        if (!atHead.matches || !pre.matches || atHead.sha256 !== pre.sha256) {
            return false;
        }

        if (atHead.sha256 === unit.publishedClsSha256) {
            return false;
        }
    }

    return true;
}

/**
 * Restore published METHOD-merge classes on the Source branch inside an existing clone.
 */
async function revertMethodMergeInRepo({
    repoPath,
    sourceBranch,
    destinationBranch,
    inputMergePins,
    publishedCommitSha,
    revertUnits,
    existingRevert = null,
    deps = {}
} = {}) {
    const git = deps.runGit || runGit;

    if (
        !repoPath ||
        !sourceBranch ||
        !inputMergePins ||
        !revertUnits?.length ||
        !publishedCommitSha
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'repoPath, sourceBranch, inputMergePins, publishedCommitSha, and revertUnits are required.'
        );
    }

    const prePublishSha = inputMergePins.sourceHeadSha;

    if (!prePublishSha) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'Merge session is missing inputMergePins.sourceHeadSha.'
        );
    }

    await git(repoPath, 'fetch origin');

    const idempotent = await tryIdempotentRevert({
        repoPath,
        sourceBranch,
        revertUnits,
        prePublishSha,
        existingRevert
    });

    if (idempotent) {
        return idempotent;
    }

    const remoteHead = await revParseOriginHead(repoPath, sourceBranch);
    const destinationHead = await revParseOriginHead(
        repoPath,
        destinationBranch
    );

    if (destinationHead !== inputMergePins.destinationHeadSha) {
        throw new ApexMergeError(
            MERGE_ERROR.PUBLISH_DESTINATION_BRANCH_CHANGED,
            'Destination branch changed during revert.',
            {
                expected: inputMergePins.destinationHeadSha,
                actual: destinationHead
            }
        );
    }

    const noCommitPublish = publishedCommitSha === prePublishSha;

    if (!noCommitPublish) {
        const ancestorOk = await isAncestor(
            repoPath,
            publishedCommitSha,
            remoteHead,
            git
        );

        if (!ancestorOk) {
            throw new ApexMergeError(
                MERGE_ERROR.REVERT_HISTORY_DIVERGED,
                'Published commit is not an ancestor of the current Source branch HEAD; revert refused.',
                { publishedCommitSha, remoteHead }
            );
        }

        const parentSha = await resolveParentSha(
            repoPath,
            publishedCommitSha,
            git
        );

        if (parentSha !== prePublishSha) {
            throw new ApexMergeError(
                MERGE_ERROR.REVERT_HISTORY_DIVERGED,
                'Pre-publish SHA does not match the parent of the published commit.',
                { prePublishSha, parentSha, publishedCommitSha }
            );
        }

        await assertPublishedFilesUnchanged(repoPath, remoteHead, revertUnits);
    }

    if (
        await alreadyAtPrePublishContent(
            repoPath,
            remoteHead,
            prePublishSha,
            revertUnits
        )
    ) {
        return {
            revertState: REVERT_STATE.REVERTED,
            revertCommitSha: null,
            revertedAt: new Date().toISOString(),
            revertedClasses: revertUnits.map((unit) => ({
                metadataName: unit.metadataName,
                filePath: unit.filePath
            })),
            noGitCommit: true
        };
    }

    const prePublishContents = new Map();

    for (const unit of revertUnits) {
        const pre = await remoteMatchesPrePublishBlob(
            repoPath,
            prePublishSha,
            unit
        );

        if (!pre.matches) {
            throw new ApexMergeError(
                MERGE_ERROR.REVERT_NOT_ELIGIBLE,
                `Pre-publish content is missing for ${unit.metadataName}.`,
                { metadataName: unit.metadataName, prePublishSha }
            );
        }

        prePublishContents.set(unit.metadataName, pre.content);
    }

    await checkoutSourceAtHead(repoPath, sourceBranch, remoteHead, git);

    const metaSnapshots = new Map();

    for (const unit of revertUnits) {
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

        await writeFile(
            absoluteCls,
            prePublishContents.get(unit.metadataName),
            'utf8'
        );
    }

    await configureLocalGitIdentity(repoPath, git);

    const stagedPaths = revertUnits
        .map((unit) => shellQuote(unit.filePath.replace(/\\/g, '/')))
        .join(' ');

    await git(repoPath, `add -- ${stagedPaths}`);

    const classNames = revertUnits.map((unit) => unit.metadataName).join(', ');
    const commitMessage = `Apex METHOD merge revert publish (${classNames})`;

    try {
        await git(repoPath, `commit -m ${shellQuote(commitMessage)}`, {
            maxBuffer: 50 * 1024 * 1024
        });
    } catch (error) {
        if (String(error.stderr || '').includes('nothing to commit')) {
            await git(repoPath, 'fetch origin');
            const headAfterNoopCommit = await revParseOriginHead(
                repoPath,
                sourceBranch
            );

            if (
                await alreadyAtPrePublishContent(
                    repoPath,
                    headAfterNoopCommit,
                    prePublishSha,
                    revertUnits
                )
            ) {
                return {
                    revertState: REVERT_STATE.REVERTED,
                    revertCommitSha: headAfterNoopCommit,
                    revertedAt: new Date().toISOString(),
                    revertedClasses: revertUnits.map((unit) => ({
                        metadataName: unit.metadataName,
                        filePath: unit.filePath
                    })),
                    noGitCommit: true
                };
            }

            throw new ApexMergeError(
                MERGE_ERROR.REVERT_NOT_ELIGIBLE,
                'Revert produced no commit while remote Source branch still has published merge content.',
                { remoteHead: headAfterNoopCommit, prePublishSha }
            );
        }

        logMethodPublishGitFailure(
            MERGE_ERROR.GIT_ERROR,
            'Git commit failed during revert.',
            error.stderr || error.message
        );

        throw new ApexMergeError(MERGE_ERROR.GIT_ERROR, 'Git commit failed during revert.', {
            cause: error.stderr || error.message
        });
    }

    for (const unit of revertUnits) {
        if (!unit.metaXmlPath) {
            continue;
        }

        const absoluteMeta = path.join(repoPath, unit.metaXmlPath);
        const before = metaSnapshots.get(unit.metadataName);
        const after = await readFile(absoluteMeta, 'utf8');

        if (before !== null && before !== after) {
            throw new ApexMergeError(
                MERGE_ERROR.REVERT_NOT_ELIGIBLE,
                `Companion metadata changed unexpectedly for ${unit.metadataName}.`,
                { metadataName: unit.metadataName }
            );
        }
    }

    const localHeadSha = (await git(repoPath, 'rev-parse HEAD')).trim();

    await git(repoPath, 'fetch origin');

    const branch = normalizeBranchRef(sourceBranch);
    const pushCommand = `push origin ${shellQuote(branch)}`;
    assertCommandDoesNotForcePush(pushCommand);

    try {
        await git(repoPath, pushCommand);
    } catch (error) {
        const reconciledSha = await reconcileRevertPushOutcome({
            repoPath,
            sourceBranch,
            revertUnits,
            prePublishSha,
            localHeadSha,
            runGit: git
        }).catch(() => null);

        if (reconciledSha) {
            return {
                revertState: REVERT_STATE.REVERTED,
                revertCommitSha: reconciledSha,
                revertedAt: new Date().toISOString(),
                revertedClasses: revertUnits.map((unit) => ({
                    metadataName: unit.metadataName,
                    filePath: unit.filePath
                })),
                noGitCommit: false
            };
        }

        logMethodPublishGitFailure(
            MERGE_ERROR.REVERT_PUSH_REJECTED,
            'Git push during revert was rejected.',
            error.stderr || error.message
        );

        throw new ApexMergeError(
            MERGE_ERROR.REVERT_PUSH_REJECTED,
            'Git push during revert was rejected.',
            { cause: error.stderr || error.message }
        );
    }

    const revertCommitSha = (await git(repoPath, 'rev-parse HEAD')).trim();
    const remoteHeadAfterPush = await revParseOriginHead(repoPath, sourceBranch);

    if (remoteHeadAfterPush !== revertCommitSha) {
        throw new ApexMergeError(
            MERGE_ERROR.REVERT_PUSH_UNCONFIRMED,
            'Revert commit SHA does not match remote Source branch HEAD after push.',
            { expected: revertCommitSha, actual: remoteHeadAfterPush }
        );
    }

    for (const unit of revertUnits) {
        const atHead = await remoteMatchesPrePublishBlob(
            repoPath,
            remoteHeadAfterPush,
            unit
        );
        const pre = await remoteMatchesPrePublishBlob(
            repoPath,
            prePublishSha,
            unit
        );

        if (!atHead.matches || !pre.matches || atHead.sha256 !== pre.sha256) {
            throw new ApexMergeError(
                MERGE_ERROR.REVERT_PUSH_UNCONFIRMED,
                `Remote content after revert does not match pre-publish content for ${unit.metadataName}.`,
                { metadataName: unit.metadataName }
            );
        }
    }

    return {
        revertState: REVERT_STATE.REVERTED,
        revertCommitSha,
        revertedAt: new Date().toISOString(),
        revertedClasses: revertUnits.map((unit) => ({
            metadataName: unit.metadataName,
            filePath: unit.filePath
        })),
        noGitCommit: false
    };
}

async function revertMethodMergeSession(session) {
    const inputMergePins = resolveInputMergePins(session);
    const { publishedCommitSha, units } = buildRevertUnits(session);

    if (
        !inputMergePins.sourceHeadSha ||
        !inputMergePins.destinationHeadSha
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'Merge session is missing immutable input merge pins.'
        );
    }

    const revertResult = await withFetchedRepository(
        session.repoUrl,
        async ({ repoPath }) =>
            revertMethodMergeInRepo({
                repoPath,
                sourceBranch: session.sourceBranch,
                destinationBranch: session.destinationBranch,
                inputMergePins,
                publishedCommitSha,
                revertUnits: units,
                existingRevert: session.revert || null
            })
    );

    return {
        ...revertResult,
        inputMergePins
    };
}

function metadataNameSet(names = []) {
    return [
        ...new Set(
            names
                .map((name) => String(name || '').trim())
                .filter(Boolean)
                .sort()
        )
    ];
}

function assertPublishNotAlreadyCompleted(session, metadataNames) {
    const publish = session.publish;

    if (!publish || publish.publishState !== PUBLISH_STATE.PUBLISHED) {
        return;
    }

    const requested = metadataNameSet(metadataNames);
    const existing = metadataNameSet(
        (publish.publishedClasses || []).map((entry) => entry.metadataName)
    );

    if (
        requested.length === existing.length &&
        requested.every((name, index) => name === existing[index])
    ) {
        return;
    }

    throw new ApexMergeError(
        MERGE_ERROR.PUBLISH_ALREADY_COMPLETED,
        'This merge session already has a successful publish; start a new session to publish again.',
        { publishedClasses: existing, requested }
    );
}

module.exports = {
    REVERT_STATE,
    buildRevertUnits,
    revertMethodMergeInRepo,
    revertMethodMergeSession,
    assertPublishNotAlreadyCompleted,
    metadataNameSet
};