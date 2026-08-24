'use strict';

const { CHANGE_CLASS, SNAPSHOT_STATUS } = require('./snapshot.types');
const { getSharedSnapshotAccess } = require('./snapshotAccess.service');
const {
    isSnapshotCaptureOnDeployEnabled
} = require('./snapshotCapture.flag');
const {
    collectFinalDeploymentMembers,
    isCaptureAllowlisted,
    mapExistenceToChangeClass,
    buildUnsupportedReason,
    buildUnknownReason,
    buildMissingArtifactReason
} = require('./destinationSnapshotMapper.service');
const {
    collectExpectedAfterArtifact,
    buildMissingExpectedAfterReason
} = require('./expectedAfterArtifact.service');
const {
    retrieveDestinationMember
} = require('./destinationMetadataRetriever.service');
const {
    buildDestinationInventory,
    getState,
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    refreshAccessToken,
    buildBlockedResult
} = require('../checkOnlyDeployment.service');

function fail(message, snapshot = null) {
    return {
        ok: false,
        message,
        snapshot
    };
}

function createDestinationSnapshotCaptureService(dependencies = {}) {
    const captureService =
        dependencies.captureService ||
        getSharedSnapshotAccess().captureService;
    const collectExpectedAfter =
        dependencies.collectExpectedAfterArtifact ||
        collectExpectedAfterArtifact;
    const inventoryBuilder =
        dependencies.buildDestinationInventory || buildDestinationInventory;
    const inventoryState = dependencies.getState || getState;
    const retrieveMember =
        dependencies.retrieveDestinationMember || retrieveDestinationMember;
    const refreshTokenFn =
        dependencies.refreshAccessToken || refreshAccessToken;
    const isEnabled =
        dependencies.isSnapshotCaptureOnDeployEnabled ||
        isSnapshotCaptureOnDeployEnabled;

    async function captureAndSealForDeploy({
        destinationOrgId,
        sourceOrgId = null,
        historyId = null,
        sourceBranch = null,
        destinationBranch = null,
        generatedDeploymentPackage,
        generatedWorkspace,
        refreshToken,
        instanceUrl,
        deploymentApiVersion = null
    } = {}) {
        if (!destinationOrgId) {
            return fail(
                'Destination snapshot capture failed: destinationOrgId is required.'
            );
        }

        const finalMembers = collectFinalDeploymentMembers(
            generatedDeploymentPackage
        );

        if (!finalMembers.length) {
            return {
                ok: true,
                skipped: true,
                snapshot: null,
                message: 'No final deployment members to snapshot.'
            };
        }

        let accessToken = null;
        let resolvedInstanceUrl = instanceUrl;

        try {
            const tokenResult = await refreshTokenFn(refreshToken);
            accessToken = tokenResult.accessToken;
            resolvedInstanceUrl = tokenResult.instanceUrl || instanceUrl;
        } catch (error) {
            return fail(
                'Destination snapshot capture failed: unable to authenticate with destination org.'
            );
        }

        let inventory = new Map();

        try {
            const inventoryResult = await inventoryBuilder({
                items: finalMembers,
                accessToken,
                instanceUrl: resolvedInstanceUrl
            });
            inventory = inventoryResult.inventory;
        } catch (error) {
            const first = finalMembers[0];
            return fail(
                buildUnknownReason(
                    first.metadataType,
                    first.metadataName,
                    'fresh destination inventory failed.'
                )
            );
        }

        const captureMembers = [];

        for (const member of finalMembers) {
            if (!isCaptureAllowlisted(member.metadataType)) {
                return fail(
                    buildUnsupportedReason(
                        member.metadataType,
                        member.metadataName
                    )
                );
            }

            const existence = inventoryState(
                inventory,
                member.metadataType,
                member.metadataName
            );
            const changeClass = mapExistenceToChangeClass(existence);

            if (changeClass === CHANGE_CLASS.UNKNOWN) {
                return fail(
                    buildUnknownReason(member.metadataType, member.metadataName)
                );
            }

            if (changeClass === CHANGE_CLASS.NEW) {
                captureMembers.push({
                    metadataType: member.metadataType,
                    metadataName: member.metadataName,
                    filePath: member.filePath,
                    changeClass: CHANGE_CLASS.NEW
                });
                continue;
            }

            let expectedAfter;

            try {
                expectedAfter = await collectExpectedAfter({
                    workspacePath: generatedWorkspace?.workspacePath,
                    member
                });
            } catch (error) {
                return fail(
                    error.message ||
                        buildMissingExpectedAfterReason(
                            member.metadataType,
                            member.metadataName
                        )
                );
            }

            if (!expectedAfter?.expectedAfterHash) {
                return fail(
                    buildMissingExpectedAfterReason(
                        member.metadataType,
                        member.metadataName
                    )
                );
            }

            let retrieved;

            try {
                retrieved = await retrieveMember({
                    refreshToken,
                    instanceUrl: resolvedInstanceUrl,
                    metadataType: member.metadataType,
                    metadataName: member.metadataName,
                    sourceApiVersion: deploymentApiVersion
                });
            } catch (error) {
                return fail(
                    error.message ||
                        buildMissingArtifactReason(
                            member.metadataType,
                            member.metadataName
                        )
                );
            }

            if (!retrieved?.artifactBytes || !retrieved.artifactBytes.length) {
                return fail(
                    buildMissingArtifactReason(
                        member.metadataType,
                        member.metadataName
                    )
                );
            }

            captureMembers.push({
                metadataType: member.metadataType,
                metadataName: member.metadataName,
                filePath: member.filePath,
                changeClass: CHANGE_CLASS.MODIFIED,
                destinationBeforeBytes: retrieved.artifactBytes,
                expectedAfterHash: expectedAfter.expectedAfterHash
            });
        }

        try {
            const ready = await captureService.captureSnapshot({
                deploymentContext: {
                    destinationOrgId,
                    sourceOrgId,
                    deploymentId: historyId,
                    sourceBranch,
                    destinationBranch
                },
                members: captureMembers
            });

            if (ready.status !== SNAPSHOT_STATUS.READY) {
                return fail(
                    'Destination snapshot capture failed: snapshot did not become READY.',
                    ready
                );
            }

            const sealed = await captureService.sealSnapshot(ready.snapshotId);

            if (sealed.status !== SNAPSHOT_STATUS.SEALED) {
                return fail(
                    'Destination snapshot capture failed: snapshot did not seal.',
                    sealed
                );
            }

            return {
                ok: true,
                snapshot: sealed
            };
        } catch (error) {
            return fail(
                error.message || 'Destination snapshot capture failed.'
            );
        }
    }

    async function runDeployAfterOptionalSnapshot({
        shouldDeploy,
        captureArgs,
        runDeploymentExecution
    }) {
        if (!shouldDeploy) {
            return {
                deploymentExecution: undefined,
                snapshot: null,
                snapshotBlocked: false
            };
        }

        if (!isEnabled()) {
            return {
                deploymentExecution: await runDeploymentExecution(),
                snapshot: null,
                snapshotBlocked: false
            };
        }

        const capture = await captureAndSealForDeploy(captureArgs);

        if (!capture.ok) {
            return {
                deploymentExecution: buildBlockedResult(capture.message, {
                    mode: 'execution',
                    executionMode: 'deploy'
                }),
                snapshot: capture.snapshot || null,
                snapshotBlocked: true
            };
        }

        return {
            deploymentExecution: await runDeploymentExecution(),
            snapshot: capture.snapshot || null,
            snapshotBlocked: false
        };
    }

    return {
        captureAndSealForDeploy,
        runDeployAfterOptionalSnapshot
    };
}

const defaultOrchestrator = createDestinationSnapshotCaptureService();

module.exports = {
    createDestinationSnapshotCaptureService,
    captureAndSealForDeploy: defaultOrchestrator.captureAndSealForDeploy,
    runDeployAfterOptionalSnapshot:
        defaultOrchestrator.runDeployAfterOptionalSnapshot,
    isSnapshotCaptureOnDeployEnabled
};
