'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const {
    generateEmptyPackageXml,
    generateDestructiveChangesXml,
    generateManifest
} = require('../packageXml.service');
const { ROLLBACK_CODE, RollbackBlockedError } = require('./snapshotRestore.errors');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const rm = util.promisify(fs.rm);

const DESTRUCTIVE_MANIFEST_FILE = 'destructiveChanges.xml';

function buildPackageMetadata(members) {
    return members.map((member) => ({
        metadataType: member.metadataType,
        metadataName: member.metadataName,
        filePath: member.filePath || null
    }));
}

async function buildDeleteRollbackWorkspace({
    members,
    apiVersion = null,
    tmpdir = os.tmpdir,
    rmFn = rm
} = {}) {
    if (!Array.isArray(members) || members.length === 0) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'Delete rollback workspace requires snapshot members.'
        );
    }

    const workspacePath = path.join(
        tmpdir(),
        `rollback-delete-${crypto.randomUUID()}`
    );
    let workspaceCreated = false;

    try {
        await mkdir(workspacePath, { recursive: true });
        workspaceCreated = true;

        const packageMetadata = buildPackageMetadata(members);
        const generatedDeploymentPackage = {
            metadata: packageMetadata,
            dependencies: []
        };
        const manifestResult = generateManifest(
            generatedDeploymentPackage,
            apiVersion ? { deploymentApiVersion: apiVersion } : {}
        );
        const resolvedApiVersion = manifestResult.summary.apiVersion;
        const packageXml = generateEmptyPackageXml(resolvedApiVersion);
        const destructiveChangesXml = generateDestructiveChangesXml(
            generatedDeploymentPackage,
            resolvedApiVersion
        );

        await writeFile(path.join(workspacePath, 'package.xml'), packageXml, 'utf8');
        await writeFile(
            path.join(workspacePath, DESTRUCTIVE_MANIFEST_FILE),
            destructiveChangesXml,
            'utf8'
        );

        return {
            workspacePath,
            workspaceCreated: true,
            packageXmlWritten: true,
            packageXmlPath: path.join(workspacePath, 'package.xml'),
            destructiveChangesXmlPath: path.join(
                workspacePath,
                DESTRUCTIVE_MANIFEST_FILE
            ),
            preDestructiveChangesPath: DESTRUCTIVE_MANIFEST_FILE,
            generatedDeploymentPackage,
            generatedManifest: {
                packageXml,
                destructiveChangesXml,
                deploymentApiVersionPolicy:
                    manifestResult.deploymentApiVersionPolicy,
                summary: {
                    metadataTypes: new Set(
                        packageMetadata.map((item) => item.metadataType)
                    ).size,
                    members: packageMetadata.length,
                    apiVersion: resolvedApiVersion
                }
            },
            metadataCopied: 0,
            dependenciesCopied: 0,
            copiedFiles: 2,
            missingFiles: [],
            status: 'READY'
        };
    } catch (error) {
        if (workspaceCreated) {
            try {
                await rmFn(workspacePath, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('DELETE_ROLLBACK_WORKSPACE_CLEANUP_FAILED');
                console.error(cleanupError?.message || cleanupError);
            }
        }

        if (error instanceof RollbackBlockedError) {
            throw error;
        }

        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            error.message || 'Delete rollback workspace failed.'
        );
    }
}

module.exports = {
    DESTRUCTIVE_MANIFEST_FILE,
    buildDeleteRollbackWorkspace
};
