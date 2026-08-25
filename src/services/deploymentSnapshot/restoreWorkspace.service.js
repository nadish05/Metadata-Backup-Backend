'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const { generatePackageXml, generateManifest } = require('../packageXml.service');
const {
    unpackMemberFiles,
    normalizeRelativePath
} = require('./destinationMemberArtifact.service');
const { ROLLBACK_CODE, RollbackBlockedError } = require('./snapshotRestore.errors');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const rm = util.promisify(fs.rm);

function assertSafeRelativePath(relativePath) {
    const posix = normalizeRelativePath(relativePath);

    if (!posix || posix === '.' || posix === '..') {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Restore artifact path is empty or invalid.'
        );
    }

    if (path.isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Restore artifact path must be relative.'
        );
    }

    const parts = posix.split('/');

    if (
        parts.some(
            (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                part.includes('\0')
        )
    ) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Restore artifact path failed traversal checks.'
        );
    }

    return posix;
}

function resolveUnderWorkspace(workspacePath, relativePath) {
    const posix = assertSafeRelativePath(relativePath);
    const root = path.resolve(workspacePath);
    const resolved = path.resolve(root, ...posix.split('/'));
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

    if (resolved !== root && !resolved.startsWith(prefix)) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Restore artifact path escaped the workspace root.'
        );
    }

    return { posix, resolved };
}

async function writeExactFile(absolutePath, bytes) {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
}

async function buildRestoreWorkspace({
    snapshot,
    members,
    getArtifact,
    tmpdir = os.tmpdir,
    rmFn = rm,
    apiVersion = null
} = {}) {
    if (!snapshot?.snapshotId) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Restore workspace requires a snapshot.'
        );
    }

    if (!Array.isArray(members) || members.length === 0) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Restore workspace requires snapshot members.'
        );
    }

    const workspacePath = path.join(
        tmpdir(),
        `rollback-restore-${crypto.randomUUID()}`
    );
    let workspaceCreated = false;
    const seenPaths = new Map();
    const packageMetadata = [];
    let copiedFiles = 0;

    try {
        await mkdir(workspacePath, { recursive: true });
        workspaceCreated = true;

        for (const member of members) {
            if (!member.artifactId) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.ARTIFACT_MISSING,
                    `Restore artifact is missing for ${member.metadataType}:${member.metadataName}.`
                );
            }

            const artifactBytes = await getArtifact(
                snapshot.snapshotId,
                member.artifactId
            );

            if (!artifactBytes || !artifactBytes.length) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.ARTIFACT_MISSING,
                    `Restore artifact is empty for ${member.metadataType}:${member.metadataName}.`
                );
            }

            let files;

            try {
                files = unpackMemberFiles(artifactBytes);
            } catch (error) {
                throw new RollbackBlockedError(
                    ROLLBACK_CODE.WORKSPACE_FAILED,
                    `Restore artifact could not be unpacked for ${member.metadataType}:${member.metadataName}.`
                );
            }

            for (const file of files) {
                const { posix, resolved } = resolveUnderWorkspace(
                    workspacePath,
                    file.relativePath
                );
                const owner = `${member.metadataType}:${member.metadataName}`;
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

            packageMetadata.push({
                metadataType: member.metadataType,
                metadataName: member.metadataName,
                filePath: member.filePath || null
            });
        }

        const generatedDeploymentPackage = {
            metadata: packageMetadata,
            dependencies: []
        };

        let packageXml;
        let generatedManifest;

        try {
            generatedManifest = generateManifest(
                generatedDeploymentPackage,
                apiVersion ? { deploymentApiVersion: apiVersion } : {}
            );
            packageXml =
                generatedManifest.packageXml ||
                generatePackageXml(generatedDeploymentPackage, apiVersion);
        } catch (error) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.PACKAGE_FAILED,
                'Rollback package.xml generation failed.'
            );
        }

        if (!packageXml) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.PACKAGE_FAILED,
                'Rollback package.xml generation failed.'
            );
        }

        const packageXmlPath = path.join(workspacePath, 'package.xml');
        await writeFile(packageXmlPath, packageXml, 'utf8');

        return {
            workspacePath,
            workspaceCreated: true,
            packageXmlWritten: true,
            packageXmlPath,
            generatedDeploymentPackage,
            generatedManifest,
            metadataCopied: packageMetadata.length,
            dependenciesCopied: 0,
            copiedFiles: copiedFiles + 1,
            missingFiles: [],
            status: 'READY'
        };
    } catch (error) {
        if (workspaceCreated) {
            try {
                await rmFn(workspacePath, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('ROLLBACK_WORKSPACE_CLEANUP_FAILED');
                console.error(cleanupError?.message || cleanupError);
            }
        }

        throw error;
    }
}

async function deleteRestoreWorkspace(workspacePath, rmFn = rm) {
    if (!workspacePath) {
        return;
    }

    try {
        await rmFn(workspacePath, { recursive: true, force: true });
    } catch (error) {
        console.error('ROLLBACK_WORKSPACE_CLEANUP_FAILED');
        console.error(error?.message || error);
        throw error;
    }
}

module.exports = {
    buildRestoreWorkspace,
    deleteRestoreWorkspace,
    assertSafeRelativePath,
    resolveUnderWorkspace
};
