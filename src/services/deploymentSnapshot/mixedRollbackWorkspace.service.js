'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const {
    generatePackageXml,
    generateEmptyPackageXml,
    generateDestructiveChangesXml,
    generateManifest
} = require('../packageXml.service');
const {
    unpackMemberFiles
} = require('./destinationMemberArtifact.service');
const {
    isDeleteRollbackEligibleMember,
    isModifiedRollbackEligibleMember
} = require('./snapshotRollbackEligibility.service');
const { resolveUnderWorkspace } = require('./restoreWorkspace.service');
const { ROLLBACK_CODE, RollbackBlockedError } = require('./snapshotRestore.errors');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const rm = util.promisify(fs.rm);

const DESTRUCTIVE_MANIFEST_FILE = 'destructiveChanges.xml';

function memberKey(member) {
    return `${member.metadataType}:${member.metadataName}`;
}

function toPackageMetadata(member) {
    return {
        metadataType: member.metadataType,
        metadataName: member.metadataName,
        filePath: member.filePath || null
    };
}

async function writeExactFile(absolutePath, bytes) {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
}

function partitionMixedRollbackMembers(members) {
    if (!Array.isArray(members) || members.length === 0) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Mixed rollback workspace requires snapshot members.'
        );
    }

    const restoreMembers = [];
    const deleteMembers = [];

    for (const member of members) {
        const restoreEligible = isModifiedRollbackEligibleMember(member);
        const deleteEligible = isDeleteRollbackEligibleMember(member);

        if (restoreEligible && deleteEligible) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.WORKSPACE_FAILED,
                `Mixed rollback member ${memberKey(member)} cannot be both restore and delete eligible.`
            );
        }

        if (restoreEligible) {
            restoreMembers.push(member);
            continue;
        }

        if (deleteEligible) {
            deleteMembers.push(member);
            continue;
        }

        throw new RollbackBlockedError(
            ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE,
            `Mixed rollback member ${memberKey(member)} is not restore or delete eligible.`
        );
    }

    return {
        restoreMembers,
        deleteMembers
    };
}

async function buildMixedRollbackWorkspace({
    snapshot,
    members,
    getArtifact,
    apiVersion = null,
    tmpdir = os.tmpdir,
    rmFn = rm
} = {}) {
    const { restoreMembers, deleteMembers } = partitionMixedRollbackMembers(members);

    if (restoreMembers.length && !snapshot?.snapshotId) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Mixed rollback workspace requires a snapshot for MODIFIED members.'
        );
    }

    if (typeof getArtifact !== 'function' && restoreMembers.length) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Mixed rollback workspace requires getArtifact for MODIFIED members.'
        );
    }

    const workspacePath = path.join(
        tmpdir(),
        `rollback-mixed-${crypto.randomUUID()}`
    );
    let workspaceCreated = false;
    const seenPaths = new Map();
    let copiedFiles = 0;

    try {
        await mkdir(workspacePath, { recursive: true });
        workspaceCreated = true;

        for (const member of restoreMembers) {
            if (!member.artifactId) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.ARTIFACT_MISSING,
                    `Restore artifact is missing for ${memberKey(member)}.`
                );
            }

            const artifactBytes = await getArtifact(
                snapshot.snapshotId,
                member.artifactId
            );

            if (!artifactBytes || !artifactBytes.length) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.ARTIFACT_MISSING,
                    `Restore artifact is empty for ${memberKey(member)}.`
                );
            }

            let files;

            try {
                files = unpackMemberFiles(artifactBytes);
            } catch (error) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.WORKSPACE_FAILED,
                    `Restore artifact could not be unpacked for ${memberKey(member)}.`
                );
            }

            for (const file of files) {
                const { posix, resolved } = resolveUnderWorkspace(
                    workspacePath,
                    file.relativePath
                );
                const owner = memberKey(member);
                const existing = seenPaths.get(posix);

                if (existing && existing !== owner) {
                    throw new RollbackBlockedError(
                        ROLLBACK_CODE.WORKSPACE_FAILED,
                        `Duplicate restore path ${posix} from ${existing} and ${owner}.`
                    );
                }

                seenPaths.set(posix, owner);
                await writeExactFile(resolved, file.bytes);
                copiedFiles += 1;
            }
        }

        const restorePackageMetadata = restoreMembers.map(toPackageMetadata);
        const deletePackageMetadata = deleteMembers.map(toPackageMetadata);
        const combinedDeploymentPackage = {
            metadata: [...restorePackageMetadata, ...deletePackageMetadata],
            dependencies: []
        };
        const manifestResult = generateManifest(
            combinedDeploymentPackage,
            apiVersion ? { deploymentApiVersion: apiVersion } : {}
        );
        const resolvedApiVersion = manifestResult.summary.apiVersion;
        const packageXml = restorePackageMetadata.length
            ? generatePackageXml(
                  {
                      metadata: restorePackageMetadata,
                      dependencies: []
                  },
                  resolvedApiVersion
              )
            : generateEmptyPackageXml(resolvedApiVersion);

        const packageXmlPath = path.join(workspacePath, 'package.xml');
        await writeFile(packageXmlPath, packageXml, 'utf8');

        let destructiveChangesXml = null;
        let destructiveChangesXmlPath = null;
        let destructiveChangesPath = null;
        let preDestructiveChangesPath = null;

        if (deletePackageMetadata.length) {
            destructiveChangesXml = generateDestructiveChangesXml(
                {
                    metadata: deletePackageMetadata,
                    dependencies: []
                },
                resolvedApiVersion
            );
            destructiveChangesXmlPath = path.join(
                workspacePath,
                DESTRUCTIVE_MANIFEST_FILE
            );
            destructiveChangesPath = destructiveChangesXmlPath;
            preDestructiveChangesPath = DESTRUCTIVE_MANIFEST_FILE;
            await writeFile(destructiveChangesXmlPath, destructiveChangesXml, 'utf8');
        }

        const manifestFileCount =
            1 + (destructiveChangesXmlPath ? 1 : 0);

        return {
            workspacePath,
            workspaceCreated: true,
            packageXmlWritten: true,
            packageXmlPath,
            destructiveChangesXmlPath,
            destructiveChangesPath,
            preDestructiveChangesPath,
            generatedDeploymentPackage: combinedDeploymentPackage,
            generatedManifest: {
                packageXml,
                destructiveChangesXml,
                deploymentApiVersionPolicy:
                    manifestResult.deploymentApiVersionPolicy,
                summary: {
                    metadataTypes: new Set(
                        combinedDeploymentPackage.metadata.map(
                            (item) => item.metadataType
                        )
                    ).size,
                    members: combinedDeploymentPackage.metadata.length,
                    restoreMembers: restorePackageMetadata.length,
                    deleteMembers: deletePackageMetadata.length,
                    apiVersion: resolvedApiVersion
                },
                restoreMemberSummary: restorePackageMetadata,
                deleteMemberSummary: deletePackageMetadata
            },
            restoreMembers: restorePackageMetadata,
            deleteMembers: deletePackageMetadata,
            metadataCopied: restorePackageMetadata.length,
            dependenciesCopied: 0,
            copiedFiles: copiedFiles + manifestFileCount,
            missingFiles: [],
            status: 'READY'
        };
    } catch (error) {
        if (workspaceCreated) {
            try {
                await rmFn(workspacePath, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('MIXED_ROLLBACK_WORKSPACE_CLEANUP_FAILED');
                console.error(cleanupError?.message || cleanupError);
            }
        }

        if (error instanceof RollbackBlockedError) {
            throw error;
        }

        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            error.message || 'Mixed rollback workspace failed.'
        );
    }
}

module.exports = {
    DESTRUCTIVE_MANIFEST_FILE,
    partitionMixedRollbackMembers,
    buildMixedRollbackWorkspace
};
