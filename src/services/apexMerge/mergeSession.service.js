'use strict';

const {
    withFetchedRepository,
    collectBranchHeads
} = require('./apexMergeGit.service');
const {
    mergeApexClassFull,
    applyResolvedArtifacts
} = require('./apexMergeFullClass.service');
const { assertNoDestinationDrift } = require('./apexMergeDrift.service');
const { buildApexMergeManifest } = require('./apexMergeManifest.service');
const { normalizeApexClassSelections } = require('./apexMergePaths.util');
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

async function createMergeSession(body = {}) {
    const {
        repoUrl,
        sourceBranch,
        destinationBranch,
        comparisonId,
        deploymentPlanId,
        classes
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

    const normalizedClasses = normalizeApexClassSelections(classes || []);

    if (!normalizedClasses.length) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'At least one ApexClass selection is required.'
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
        deploymentPlanId
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

    return {
        success: true,
        mergeSessionId,
        status: updated.status,
        comparisonId: updated.comparisonId,
        deploymentPlanId: updated.deploymentPlanId,
        classes: updated.classes.map((unit) => ({
            metadataName: unit.metadataName,
            filePath: unit.filePath,
            metaXmlPath: unit.metaXmlPath,
            mergeBaseSha: unit.mergeBaseSha,
            conflictState: unit.conflictState,
            drift: unit.drift,
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
        }))
    };
}

function resolveMergeSession(mergeSessionId, body = {}) {
    const session = requireOpenSession(mergeSessionId, body);
    const resolutions = Array.isArray(body.resolutions) ? body.resolutions : [];
    const resolutionByName = new Map(
        resolutions.map((entry) => [entry.metadataName, entry.resolutions || {}])
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

        return applyResolvedArtifacts(unit, resolution);
    });

    const updated = updateSession(mergeSessionId, {
        status: SESSION_STATUS.RESOLVED,
        classes: nextClasses
    });

    return {
        success: true,
        mergeSessionId,
        status: updated.status,
        classes: updated.classes.map((unit) => ({
            metadataName: unit.metadataName,
            conflictState: unit.conflictState
        }))
    };
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

module.exports = {
    createMergeSession,
    previewMergeSession,
    resolveMergeSession,
    sealMergeSession,
    getMergeSession
};
