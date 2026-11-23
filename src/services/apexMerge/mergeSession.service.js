'use strict';

const {
    withFetchedRepository,
    collectBranchHeads
} = require('./apexMergeGit.service');
const {
    mergeApexClassFull,
    resolveUnitArtifacts,
    buildConflictSummaries
} = require('./apexMergeFullClass.service');
const apexMergeDrift = require('./apexMergeDrift.service');
const { buildApexMergeManifest } = require('./apexMergeManifest.service');
const {
    normalizeApexClassSelections,
    coalesceClassSelectionInput
} = require('./apexMergePaths.util');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    createSessionRecord,
    getSession,
    updateSession,
    sealSession,
    SESSION_STATUS
} = require('./mergeSession.store');
const {
    previewApexClassMethod,
    resolveMethodMergeUnit,
    validateMethodUnitForSeal,
    shouldUseMethodMode,
    buildMethodConflictSummariesAll,
    METHOD_MERGE_MODE
} = require('./apexMergeMethodSession.service');
const {
    publishMethodMergeSession,
    resolveInputMergePins,
    PUBLISH_STATE
} = require('./apexMergePublish.service');
const {
    revertMethodMergeSession,
    assertPublishNotAlreadyCompleted,
    REVERT_STATE
} = require('./apexMergeRevertPublish.service');

function assertCorrelation(session, { comparisonId, deploymentPlanId }) {
    if (comparisonId && session.comparisonId !== comparisonId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'comparisonId does not match session.'
        );
    }

    if (deploymentPlanId && session.deploymentPlanId !== deploymentPlanId) {
        throw new ApexMergeError(
            MERGE_ERROR.CORRELATION_MISMATCH,
            'deploymentPlanId does not match session.'
        );
    }
}

function requireOpenSession(mergeSessionId, { comparisonId, deploymentPlanId } = {}) {
    const session = getSession(mergeSessionId);

    if (!session) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_NOT_FOUND,
            'Merge session was not found or has expired.'
        );
    }

    if (session.status === SESSION_STATUS.SEALED) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_SEALED,
            'Merge session is already sealed.'
        );
    }

    if (session.status === SESSION_STATUS.REVERTED) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_REVERTED,
            'Merge session has been reverted and is no longer mutable.',
            { revert: session.revert || null }
        );
    }

    assertCorrelation(session, { comparisonId, deploymentPlanId });
    return session;
}

function requireRevertEligibleSession(mergeSessionId, { comparisonId, deploymentPlanId } = {}) {
    const session = getSession(mergeSessionId);

    if (!session) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_NOT_FOUND,
            'Merge session was not found or has expired.'
        );
    }

    if (session.status === SESSION_STATUS.SEALED) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_SEALED,
            'Cannot revert a sealed merge session.'
        );
    }

    if (session.revertInProgress) {
        throw new ApexMergeError(
            MERGE_ERROR.REVERT_IN_PROGRESS,
            'A revert operation is already in progress for this merge session.'
        );
    }

    if (
        !session.publish ||
        session.publish.publishState !== PUBLISH_STATE.PUBLISHED
    ) {
        throw new ApexMergeError(
            MERGE_ERROR.REVERT_NOT_ELIGIBLE,
            'Merge session has not been successfully published.'
        );
    }

    assertCorrelation(session, { comparisonId, deploymentPlanId });
    return session;
}

function mapClassPreviewResponse(unit) {
    const isMethodMode = unit.mergeMode === METHOD_MERGE_MODE;
    const conflicts = isMethodMode
        ? buildMethodConflictSummariesAll(unit.metadataName, unit.methodMerge)
        : buildConflictSummaries(unit);
    const hasConflicts = isMethodMode
        ? (unit.methodMerge?.conflictCount ?? 0) > 0 ||
          (unit.methodMerge?.nestedClassConflictCount ?? 0) > 0 ||
          (unit.methodMerge?.declarationConflictCount ?? 0) > 0
        : conflicts.length > 0;
    const mergedContent = isMethodMode
        ? unit.artifacts?.cls?.content ?? null
        : unit.artifacts?.cls?.content ?? '';

    const mapped = {
        metadataName: unit.metadataName,
        filePath: unit.filePath,
        metaXmlPath: unit.metaXmlPath,
        mergeMode: unit.mergeMode || 'FULL',
        mergeBaseSha: unit.mergeBaseSha,
        conflictState: unit.conflictState,
        drift: unit.drift,
        hasConflicts,
        conflicts,
        mergedContent,
        mergedMetaXml: unit.artifacts?.metaXml?.content ?? '',
        artifacts: {
            cls: {
                conflict: unit.artifacts.cls.conflict,
                byteLength: Buffer.byteLength(
                    unit.artifacts.cls.content || '',
                    'utf8'
                )
            },
            metaXml: {
                conflict: unit.artifacts.metaXml.conflict,
                byteLength: Buffer.byteLength(
                    unit.artifacts.metaXml.content || '',
                    'utf8'
                )
            }
        },
        preview: {
            cls: unit.artifacts.cls.content,
            metaXml: unit.artifacts.metaXml.content
        }
    };

    if (isMethodMode) {
        mapped.methods = unit.methodMerge?.methods ?? [];
        mapped.conflictCount = unit.methodMerge?.conflictCount ?? 0;
        mapped.nestedClasses = unit.methodMerge?.nestedClasses ?? [];
        mapped.nestedClassConflictCount =
            unit.methodMerge?.nestedClassConflictCount ?? 0;
        mapped.nestedClassComposeReady =
            unit.methodMerge?.nestedClassComposeReady === true;
        mapped.compositionReady =
            unit.methodMerge?.compositionReady === true;
        mapped.resolved = unit.methodMerge?.resolved === true;
        mapped.declarations = unit.methodMerge?.declarations ?? null;
        mapped.declarationConflictCount =
            unit.methodMerge?.declarationConflictCount ?? 0;
        mapped.declarationsResolved =
            unit.methodMerge?.declarationsResolved === true;
    }

    return mapped;
}

function buildPerClassFocusResponse(classes, focusMetadataName) {
    if (!focusMetadataName) {
        return null;
    }

    const unit = classes.find(
        (entry) => entry.metadataName === focusMetadataName
    );

    if (!unit) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            `metadataName ${focusMetadataName} is not part of this merge session.`
        );
    }

    const mapped = mapClassPreviewResponse(unit);

    const focus = {
        metadataName: mapped.metadataName,
        mergeMode: mapped.mergeMode,
        hasConflicts: mapped.hasConflicts,
        conflicts: mapped.conflicts,
        mergedContent: mapped.mergedContent,
        mergedMetaXml: mapped.mergedMetaXml,
        mergedPreview: mapped.mergedContent,
        conflictState: mapped.conflictState
    };

    if (mapped.mergeMode === METHOD_MERGE_MODE) {
        focus.methods = mapped.methods;
        focus.conflictCount = mapped.conflictCount;
        focus.resolved = mapped.resolved;
        focus.compositionReady = mapped.compositionReady;
        focus.nestedClasses = mapped.nestedClasses;
        focus.nestedClassConflictCount = mapped.nestedClassConflictCount;
        focus.nestedClassComposeReady = mapped.nestedClassComposeReady;
        focus.declarations = mapped.declarations;
        focus.declarationConflictCount = mapped.declarationConflictCount;
        focus.declarationsResolved = mapped.declarationsResolved;
    }

    return focus;
}

function normalizeResolutionRequests(body = {}) {
    if (Array.isArray(body.resolutions) && body.resolutions.length) {
        return body.resolutions;
    }

    if (
        body.metadataName &&
        (Array.isArray(body.methodResolutions) ||
            Array.isArray(body.declarationResolutions) ||
            Array.isArray(body.nestedClassResolutions))
    ) {
        return [
            {
                metadataName: body.metadataName,
                methodResolutions: body.methodResolutions || [],
                declarationResolutions: body.declarationResolutions || [],
                nestedClassResolutions: body.nestedClassResolutions || []
            }
        ];
    }

    if (body.metadataName) {
        return [
            {
                metadataName: body.metadataName,
                resolutionStrategy: body.resolutionStrategy,
                methodResolutions: body.methodResolutions,
                declarationResolutions: body.declarationResolutions,
                nestedClassResolutions: body.nestedClassResolutions,
                resolutions: body.resolutions
            }
        ];
    }

    return [];
}

function resolutionTargetMetadataNames(resolutionRequests = []) {
    return new Set(
        resolutionRequests
            .map((entry) => String(entry.metadataName || '').trim())
            .filter(Boolean)
    );
}

function assertResolutionTargetsInSession(session, targetNames) {
    for (const metadataName of targetNames) {
        const exists = (session.classes || []).some(
            (unit) => unit.metadataName === metadataName
        );

        if (!exists) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                `metadataName ${metadataName} is not part of this merge session.`
            );
        }
    }
}

async function createMergeSession(body = {}) {
    const {
        repoUrl,
        sourceBranch,
        destinationBranch,
        comparisonId,
        deploymentPlanId
    } = body;

    if (!repoUrl || !sourceBranch || !destinationBranch) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'repoUrl, sourceBranch, and destinationBranch are required.'
        );
    }

    if (!comparisonId || !deploymentPlanId) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'comparisonId and deploymentPlanId are required.'
        );
    }

    const normalizedClasses = normalizeApexClassSelections(
        coalesceClassSelectionInput(body)
    );

    if (!normalizedClasses.length) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'At least one ApexClass selection is required (classes or eligibleClasses).'
        );
    }

    let gitPins;

    await withFetchedRepository(repoUrl, async ({ repoPath }) => {
        gitPins = await collectBranchHeads(
            repoPath,
            sourceBranch,
            destinationBranch
        );
    });

    const session = createSessionRecord({
        comparisonId,
        deploymentPlanId,
        repoUrl,
        sourceBranch,
        destinationBranch,
        gitPins: {
            ...gitPins,
            recordedAt: new Date().toISOString()
        },
        inputMergePins: {
            sourceHeadSha: gitPins.sourceHeadSha,
            destinationHeadSha: gitPins.destinationHeadSha
        },
        publish: null,
        classes: normalizedClasses.map((item) => ({
            metadataName: item.metadataName,
            filePath: item.filePath,
            mergeMode: 'FULL',
            mergeBaseSha: null,
            conflictState: 'PENDING',
            drift: null,
            threeWay: null,
            artifacts: {
                cls: { content: null, conflict: false },
                metaXml: { content: null, conflict: false }
            }
        }))
    });

    return {
        success: true,
        mergeSessionId: session.mergeSessionId,
        status: session.status,
        gitPins: session.gitPins,
        comparisonId: session.comparisonId,
        deploymentPlanId: session.deploymentPlanId,
        classes: session.classes.map((unit) => ({
            metadataName: unit.metadataName,
            filePath: unit.filePath
        }))
    };
}

async function previewMergeSession(mergeSessionId, body = {}) {
    const session = requireOpenSession(mergeSessionId, body);
    const {
        refreshToken,
        instanceUrl,
        comparisonId,
        deploymentPlanId,
        metadataName: focusMetadataName,
        mode: requestMode
    } = body;
    const trimmedFocus = focusMetadataName
        ? String(focusMetadataName).trim()
        : null;

    const mergedClasses = [];

    await withFetchedRepository(session.repoUrl, async ({ repoPath }) => {
        const currentPins = await collectBranchHeads(
            repoPath,
            session.sourceBranch,
            session.destinationBranch
        );

        if (
            currentPins.sourceHeadSha !== session.gitPins.sourceHeadSha ||
            currentPins.destinationHeadSha !==
                session.gitPins.destinationHeadSha
        ) {
            throw new ApexMergeError(
                MERGE_ERROR.STALE_GIT_PINS,
                'Git branch HEAD SHAs changed since session creation.',
                { sessionPins: session.gitPins, currentPins }
            );
        }

        if (!refreshToken || !instanceUrl) {
            throw new ApexMergeError(
                MERGE_ERROR.INVALID_REQUEST,
                'refreshToken and instanceUrl are required for merge preview drift checks.'
            );
        }

        for (const unit of session.classes) {
            const drift = await apexMergeDrift.assertNoDestinationDrift({
                repoPath,
                destinationBranch: session.destinationBranch,
                metadataName: unit.metadataName,
                filePath: unit.filePath,
                refreshToken,
                instanceUrl,
                destinationHeadSha: session.gitPins.destinationHeadSha
            });

            if (trimmedFocus && unit.metadataName !== trimmedFocus) {
                mergedClasses.push({ ...unit, drift });
                continue;
            }

            const useMethodMode = shouldUseMethodMode(
                requestMode,
                trimmedFocus,
                unit.metadataName
            );

            const mergeResult = useMethodMode
                ? await previewApexClassMethod({
                      repoPath,
                      sourceBranch: session.sourceBranch,
                      destinationBranch: session.destinationBranch,
                      metadataName: unit.metadataName,
                      filePath: unit.filePath
                  })
                : await mergeApexClassFull({
                      repoPath,
                      sourceBranch: session.sourceBranch,
                      destinationBranch: session.destinationBranch,
                      metadataName: unit.metadataName,
                      filePath: unit.filePath
                  });

            const nextUnit = {
                ...unit,
                ...mergeResult,
                conflictState:
                    mergeResult.conflictState === 'UNRESOLVED'
                        ? 'UNRESOLVED'
                        : 'NONE'
            };

            mergedClasses.push(nextUnit);
        }
    });

    const updated = updateSession(mergeSessionId, {
        status: SESSION_STATUS.PREVIEWED,
        classes: mergedClasses
    });

    const classResponses = updated.classes.map(mapClassPreviewResponse);
    const focus = buildPerClassFocusResponse(
        updated.classes,
        focusMetadataName ? String(focusMetadataName).trim() : null
    );

    const response = {
        success: true,
        mergeSessionId,
        status: updated.status,
        comparisonId: updated.comparisonId,
        deploymentPlanId: updated.deploymentPlanId,
        classes: classResponses
    };

    if (focus) {
        Object.assign(response, focus);
    }

    return response;
}

function resolveMergeSession(mergeSessionId, body = {}) {
    const session = requireOpenSession(mergeSessionId, body);
    const resolutionRequests = normalizeResolutionRequests(body);

    if (!resolutionRequests.length) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'Resolution request must identify at least one class.'
        );
    }

    const resolutionTargets = resolutionTargetMetadataNames(resolutionRequests);
    assertResolutionTargetsInSession(session, resolutionTargets);

    const resolutionByName = new Map(
        resolutionRequests.map((entry) => [entry.metadataName, entry])
    );

    const nextClasses = session.classes.map((unit) => {
        if (!resolutionTargets.has(unit.metadataName)) {
            return unit;
        }

        const resolution = resolutionByName.get(unit.metadataName);

        if (unit.mergeMode === METHOD_MERGE_MODE) {
            if (!resolution) {
                if (unit.conflictState === 'UNRESOLVED') {
                    throw new ApexMergeError(
                        MERGE_ERROR.UNRESOLVED_CONFLICT,
                        `Missing METHOD resolution for ${unit.metadataName}.`
                    );
                }

                return {
                    ...unit,
                    conflictState:
                        unit.conflictState === 'PENDING'
                            ? 'NONE'
                            : unit.conflictState
                };
            }

            return resolveMethodMergeUnit(unit, resolution);
        }

        if (unit.conflictState === 'UNRESOLVED' && !resolution) {
            throw new ApexMergeError(
                MERGE_ERROR.UNRESOLVED_CONFLICT,
                `Missing resolution for ${unit.metadataName}.`
            );
        }

        if (!resolution) {
            return {
                ...unit,
                conflictState:
                    unit.conflictState === 'PENDING' ? 'NONE' : unit.conflictState
            };
        }

        return resolveUnitArtifacts(unit, resolution);
    });

    const updated = updateSession(mergeSessionId, {
        status: SESSION_STATUS.RESOLVED,
        classes: nextClasses
    });

    const focusMetadataName = body.metadataName
        ? String(body.metadataName).trim()
        : null;
    const focusUnit = focusMetadataName
        ? updated.classes.find((unit) => unit.metadataName === focusMetadataName)
        : null;

    const response = {
        success: true,
        mergeSessionId,
        status: updated.status,
        classes: updated.classes.map((unit) => ({
            metadataName: unit.metadataName,
            conflictState: unit.conflictState,
            artifacts: {
                cls: { sha256: unit.artifacts?.cls?.sha256 || null },
                metaXml: { sha256: unit.artifacts?.metaXml?.sha256 || null }
            }
        }))
    };

    if (focusUnit) {
        const isMethodMode = focusUnit.mergeMode === METHOD_MERGE_MODE;
        const conflicts = isMethodMode
            ? buildMethodConflictSummariesAll(
                  focusUnit.metadataName,
                  focusUnit.methodMerge
              )
            : buildConflictSummaries(focusUnit);
        const resolveBody = {
            metadataName: focusUnit.metadataName,
            mergeMode: focusUnit.mergeMode || 'FULL',
            hasConflicts: isMethodMode
                ? (focusUnit.methodMerge?.conflictCount ?? 0) > 0 ||
                  (focusUnit.methodMerge?.nestedClassConflictCount ?? 0) > 0 ||
                  (focusUnit.methodMerge?.declarationConflictCount ?? 0) > 0
                : conflicts.length > 0,
            conflicts,
            mergedContent: isMethodMode
                ? focusUnit.artifacts?.cls?.content ?? null
                : focusUnit.artifacts?.cls?.content ?? '',
            mergedMetaXml: focusUnit.artifacts?.metaXml?.content ?? '',
            mergedPreview: focusUnit.artifacts?.cls?.content ?? '',
            conflictState: focusUnit.conflictState
        };

        if (isMethodMode) {
            resolveBody.methods = focusUnit.methodMerge?.methods ?? [];
            resolveBody.conflictCount =
                focusUnit.methodMerge?.conflictCount ?? 0;
            resolveBody.resolved = focusUnit.methodMerge?.resolved === true;
            resolveBody.compositionReady =
                focusUnit.methodMerge?.compositionReady === true;
            resolveBody.nestedClasses = focusUnit.methodMerge?.nestedClasses ?? [];
            resolveBody.nestedClassConflictCount =
                focusUnit.methodMerge?.nestedClassConflictCount ?? 0;
            resolveBody.nestedClassComposeReady =
                focusUnit.methodMerge?.nestedClassComposeReady === true;
            resolveBody.declarations = focusUnit.methodMerge?.declarations ?? null;
            resolveBody.declarationConflictCount =
                focusUnit.methodMerge?.declarationConflictCount ?? 0;
            resolveBody.declarationsResolved =
                focusUnit.methodMerge?.declarationsResolved === true;
        }

        Object.assign(response, resolveBody);
    }

    return response;
}

function normalizePublishMetadataNames(body = {}) {
    if (Array.isArray(body.metadataNames) && body.metadataNames.length) {
        return body.metadataNames.map((name) => String(name || '').trim());
    }

    if (body.metadataName) {
        return [String(body.metadataName).trim()];
    }

    throw new ApexMergeError(
        MERGE_ERROR.INVALID_REQUEST,
        'metadataNames is required for publish.'
    );
}

async function publishMergeSession(mergeSessionId, body = {}) {
    const session = requireOpenSession(mergeSessionId, body);
    const metadataNames = normalizePublishMetadataNames(body);

    assertPublishNotAlreadyCompleted(session, metadataNames);

    const publishResult = await publishMethodMergeSession(
        session,
        metadataNames
    );

    const updated = updateSession(mergeSessionId, {
        publish: {
            publishState: publishResult.publishState,
            publishedCommitSha: publishResult.publishedCommitSha,
            publishedAt: publishResult.publishedAt,
            publishedClasses: publishResult.publishedClasses
        }
    });

    const inputMergePins =
        updated.inputMergePins || resolveInputMergePins(updated);

    return {
        success: true,
        mergeSessionId,
        publishState: publishResult.publishState,
        publishedCommitSha: publishResult.publishedCommitSha,
        publishedAt: publishResult.publishedAt,
        publishedClasses: publishResult.publishedClasses,
        inputMergePins
    };
}

async function revertPublishedMerge(mergeSessionId, body = {}) {
    let session = getSession(mergeSessionId);

    if (!session) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_NOT_FOUND,
            'Merge session was not found or has expired.'
        );
    }

    assertCorrelation(session, {
        comparisonId: body.comparisonId,
        deploymentPlanId: body.deploymentPlanId
    });

    if (
        session.status === SESSION_STATUS.REVERTED ||
        session.revert?.revertState === REVERT_STATE.REVERTED
    ) {
        const existing = session.revert || {};
        return {
            success: true,
            mergeSessionId,
            revertState: existing.revertState || REVERT_STATE.REVERTED,
            revertCommitSha: existing.revertCommitSha ?? null,
            revertedAt: existing.revertedAt,
            revertedClasses: existing.revertedClasses || []
        };
    }

    requireRevertEligibleSession(mergeSessionId, body);

    updateSession(mergeSessionId, { revertInProgress: true });

    let revertResult;

    try {
        session = getSession(mergeSessionId);
        revertResult = await revertMethodMergeSession(session);
    } catch (error) {
        updateSession(mergeSessionId, { revertInProgress: false });
        throw error;
    }

    const updated = updateSession(mergeSessionId, {
        status: SESSION_STATUS.REVERTED,
        revertInProgress: false,
        revert: {
            revertState: revertResult.revertState,
            revertCommitSha: revertResult.revertCommitSha ?? null,
            revertedAt: revertResult.revertedAt,
            revertedClasses: revertResult.revertedClasses,
            noGitCommit: revertResult.noGitCommit === true
        }
    });

    return {
        success: true,
        mergeSessionId,
        revertState: updated.revert.revertState,
        revertCommitSha: updated.revert.revertCommitSha,
        revertedAt: updated.revert.revertedAt,
        revertedClasses: updated.revert.revertedClasses
    };
}

function sealMergeSession(mergeSessionId, body = {}) {
    const session = requireOpenSession(mergeSessionId, body);

    for (const unit of session.classes || []) {
        validateMethodUnitForSeal(unit);
    }

    const manifest = buildApexMergeManifest(session);
    const sealed = sealSession(mergeSessionId, manifest);

    return {
        success: true,
        mergeSessionId,
        status: sealed.status,
        apexMergeManifest: manifest
    };
}

function getMergeSession(mergeSessionId) {
    const session = getSession(mergeSessionId);

    if (!session) {
        throw new ApexMergeError(
            MERGE_ERROR.SESSION_NOT_FOUND,
            'Merge session was not found or has expired.'
        );
    }

    return {
        success: true,
        mergeSessionId: session.mergeSessionId,
        status: session.status,
        comparisonId: session.comparisonId,
        deploymentPlanId: session.deploymentPlanId,
        gitPins: session.gitPins,
        inputMergePins: session.inputMergePins || resolveInputMergePins(session),
        publish: session.publish || null,
        revert: session.revert || null,
        sealedAt: session.sealedAt,
        classes: (session.classes || []).map((unit) => ({
            metadataName: unit.metadataName,
            filePath: unit.filePath,
            conflictState: unit.conflictState
        })),
        apexMergeManifest: session.manifest || null
    };
}

const {
    retrieveSealedMergeArtifact,
    authorizeArtifactHandoff
} = require('./apexMergeArtifactHandoff.service');

module.exports = {
    createMergeSession,
    previewMergeSession,
    resolveMergeSession,
    publishMergeSession,
    revertPublishedMerge,
    sealMergeSession,
    getMergeSession,
    authorizeArtifactHandoff,
    retrieveSealedMergeArtifact,
    mapClassPreviewResponse,
    buildPerClassFocusResponse,
    normalizeResolutionRequests,
    coalesceClassSelectionInput
};
