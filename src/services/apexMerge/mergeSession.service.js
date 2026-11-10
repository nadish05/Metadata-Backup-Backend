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
const { assertNoDestinationDrift } = require('./apexMergeDrift.service');
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

    assertCorrelation(session, { comparisonId, deploymentPlanId });
    return session;
}

function mapClassPreviewResponse(unit) {
    const conflicts = buildConflictSummaries(unit);

    return {
        metadataName: unit.metadataName,
        filePath: unit.filePath,
        metaXmlPath: unit.metaXmlPath,
        mergeBaseSha: unit.mergeBaseSha,
        conflictState: unit.conflictState,
        drift: unit.drift,
        hasConflicts: conflicts.length > 0,
        conflicts,
        mergedContent: unit.artifacts?.cls?.content ?? '',
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

    return {
        metadataName: mapped.metadataName,
        hasConflicts: mapped.hasConflicts,
        conflicts: mapped.conflicts,
        mergedContent: mapped.mergedContent,
        mergedMetaXml: mapped.mergedMetaXml,
        mergedPreview: mapped.mergedContent,
        conflictState: mapped.conflictState
    };
}

function normalizeResolutionRequests(body = {}) {
    if (Array.isArray(body.resolutions) && body.resolutions.length) {
        return body.resolutions;
    }

    if (body.metadataName) {
        return [
            {
                metadataName: body.metadataName,
                resolutionStrategy: body.resolutionStrategy,
                resolutions: body.resolutions
            }
        ];
    }

    return [];
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
        metadataName: focusMetadataName
    } = body;

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
            const drift = await assertNoDestinationDrift({
                repoPath,
                destinationBranch: session.destinationBranch,
                metadataName: unit.metadataName,
                filePath: unit.filePath,
                refreshToken,
                instanceUrl,
                destinationHeadSha: session.gitPins.destinationHeadSha
            });
            unit.drift = drift;

            const mergeResult = await mergeApexClassFull({
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
    const resolutionByName = new Map(
        resolutionRequests.map((entry) => [entry.metadataName, entry])
    );

    const nextClasses = session.classes.map((unit) => {
        const resolution = resolutionByName.get(unit.metadataName);

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
        const conflicts = buildConflictSummaries(focusUnit);
        Object.assign(response, {
            metadataName: focusUnit.metadataName,
            hasConflicts: conflicts.length > 0,
            conflicts,
            mergedContent: focusUnit.artifacts?.cls?.content ?? '',
            mergedMetaXml: focusUnit.artifacts?.metaXml?.content ?? '',
            mergedPreview: focusUnit.artifacts?.cls?.content ?? '',
            conflictState: focusUnit.conflictState
        });
    }

    return response;
}

function sealMergeSession(mergeSessionId, body = {}) {
    const session = requireOpenSession(mergeSessionId, body);
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
    retrieveSealedMergeArtifact
} = require('./apexMergeArtifactHandoff.service');

module.exports = {
    createMergeSession,
    previewMergeSession,
    resolveMergeSession,
    sealMergeSession,
    getMergeSession,
    retrieveSealedMergeArtifact,
    mapClassPreviewResponse,
    buildPerClassFocusResponse,
    normalizeResolutionRequests,
    coalesceClassSelectionInput
};
