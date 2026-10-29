'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const stat = util.promisify(fs.stat);

const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Digest inputs (deterministic, server-computed):
 * - schemaVersion
 * - profileOnlyMinimalPackageApplied (boolean)
 * - autoExcludeShapeFormulaConflicts (boolean|null)
 * - destinationOrgId (string|null)
 * - deploymentApiVersion (from manifest summary/policy)
 * - packageXmlSha256 (normalized LF, trimmed)
 * - deployableFiles: sorted relative paths under workspace with sha256 per file
 *   (excludes .sf/, .sfdx/, sfdx-project.json — CLI/bootstrap noise)
 */

const EXCLUDED_RELATIVE_PREFIXES = ['.sf/', '.sfdx/'];
const EXCLUDED_RELATIVE_FILES = new Set(['sfdx-project.json']);

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256String(value) {
    return sha256Buffer(Buffer.from(String(value ?? ''), 'utf8'));
}

function normalizePackageXml(xml) {
    if (typeof xml !== 'string') {
        return '';
    }

    return xml.replace(/\r\n/g, '\n').trim();
}

async function listDeployableWorkspaceFiles(workspacePath) {
    const files = [];

    async function walk(relativeDir) {
        const absoluteDir = relativeDir
            ? path.join(workspacePath, relativeDir)
            : workspacePath;
        const entries = await readdir(absoluteDir, { withFileTypes: true });

        for (const entry of entries) {
            const relativePath = relativeDir
                ? `${relativeDir}/${entry.name}`.replace(/\\/g, '/')
                : entry.name;

            if (entry.isDirectory()) {
                if (
                    relativePath === '.sf' ||
                    relativePath === '.sfdx' ||
                    relativePath.startsWith('.sf/') ||
                    relativePath.startsWith('.sfdx/')
                ) {
                    continue;
                }

                await walk(relativePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            if (EXCLUDED_RELATIVE_FILES.has(relativePath)) {
                continue;
            }

            if (
                EXCLUDED_RELATIVE_PREFIXES.some((prefix) =>
                    relativePath.startsWith(prefix)
                )
            ) {
                continue;
            }

            files.push(relativePath);
        }
    }

    await walk('');
    files.sort((a, b) => a.localeCompare(b));
    return files;
}

async function computeDeployableArtifactDigest({
    workspacePath,
    packageXml,
    profileOnlyMinimalPackageApplied,
    autoExcludeShapeFormulaConflicts,
    destinationOrgId,
    deploymentApiVersion
}) {
    let packageXmlForDigest = packageXml;

    try {
        const packageXmlPath = path.join(workspacePath, 'package.xml');
        packageXmlForDigest = await readFile(packageXmlPath, 'utf8');
    } catch (error) {
        packageXmlForDigest = packageXml;
    }

    const normalizedXml = normalizePackageXml(packageXmlForDigest);
    const packageXmlSha256 = sha256String(normalizedXml);
    const deployableFiles = [];

    for (const relativePath of await listDeployableWorkspaceFiles(
        workspacePath
    )) {
        const absolutePath = path.join(workspacePath, relativePath);
        const content = await readFile(absolutePath);
        deployableFiles.push({
            path: relativePath,
            sha256: sha256Buffer(content)
        });
    }

    const canonicalPayload = {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        profileOnlyMinimalPackageApplied: profileOnlyMinimalPackageApplied === true,
        autoExcludeShapeFormulaConflicts:
            autoExcludeShapeFormulaConflicts === true
                ? true
                : autoExcludeShapeFormulaConflicts === false
                  ? false
                  : null,
        destinationOrgId: destinationOrgId || null,
        deploymentApiVersion: deploymentApiVersion || null,
        packageXmlSha256,
        deployableFiles
    };

    return {
        digest: sha256String(JSON.stringify(canonicalPayload)),
        packageXmlSha256,
        deployableFileCount: deployableFiles.length,
        canonicalPayload
    };
}

function wasProfileOnlyMinimalPackageApplied(deploymentPackage, generatedPackage) {
    if (deploymentPackage?.profileOnlyMinimalPackage !== true) {
        return false;
    }

    const metadata = generatedPackage?.metadata;

    if (!Array.isArray(metadata) || metadata.length === 0) {
        return false;
    }

    return metadata.every(
        (item) => item?.metadataType === 'Profile' && item?.metadataName
    );
}

function resolveCheckOnlySuccess(checkOnlyDeployment) {
    if (!checkOnlyDeployment || typeof checkOnlyDeployment !== 'object') {
        return false;
    }

    if (checkOnlyDeployment.success === true) {
        return true;
    }

    const status = String(checkOnlyDeployment.status || '')
        .trim()
        .toUpperCase();

    return status === 'SUCCESS' || status === 'SUCCEEDED';
}

/**
 * Build server-side artifact identity after a successful validation run.
 * Returns null when the run is not eligible for bound deploy reuse.
 */
async function buildBoundDeployArtifactRecord({
    validationId = null,
    orgId = null,
    deploymentPackage = null,
    finalResponse = null
} = {}) {
    const generatedWorkspace = finalResponse?.generatedWorkspace || null;
    const generatedManifest = finalResponse?.generatedManifest || null;
    const checkOnlyDeployment = finalResponse?.checkOnlyDeployment || null;
    const generatedPackage = finalResponse?.generatedDeploymentPackage || null;
    const deploymentReadiness = finalResponse?.deploymentReadiness || null;

    if (!validationId) {
        return null;
    }

    if (!resolveCheckOnlySuccess(checkOnlyDeployment)) {
        return null;
    }

    if (generatedWorkspace?.status !== 'READY' || !generatedWorkspace?.workspacePath) {
        return null;
    }

    if (deploymentReadiness?.canDeploy !== true) {
        return null;
    }

    const profileOnlyMinimalPackageApplied = wasProfileOnlyMinimalPackageApplied(
        deploymentPackage,
        generatedPackage
    );

    if (!profileOnlyMinimalPackageApplied) {
        return null;
    }

    const deploymentApiVersion =
        generatedManifest?.summary?.apiVersion ||
        generatedManifest?.deploymentApiVersionPolicy?.deploymentApiVersion ||
        null;

    const digestResult = await computeDeployableArtifactDigest({
        workspacePath: generatedWorkspace.workspacePath,
        packageXml: generatedManifest?.packageXml,
        profileOnlyMinimalPackageApplied: true,
        autoExcludeShapeFormulaConflicts:
            deploymentPackage?.autoExcludeShapeFormulaConflicts,
        destinationOrgId: orgId ?? null,
        deploymentApiVersion
    });

    return {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        validationId,
        destinationOrgId: orgId ?? null,
        profileOnlyMinimalPackageApplied: true,
        autoExcludeShapeFormulaConflicts:
            deploymentPackage?.autoExcludeShapeFormulaConflicts === true
                ? true
                : deploymentPackage?.autoExcludeShapeFormulaConflicts === false
                  ? false
                  : null,
        validationMode: 'VALIDATE',
        workspacePath: generatedWorkspace.workspacePath,
        artifactDigest: digestResult.digest,
        packageXmlSha256: digestResult.packageXmlSha256,
        deployableFileCount: digestResult.deployableFileCount,
        recordedAt: new Date().toISOString(),
        checkOnlyDeploymentId: checkOnlyDeployment?.deploymentId || null
    };
}

async function verifyWorkspaceArtifactIntegrity(artifactRecord, manifest) {
    if (!artifactRecord?.workspacePath || !artifactRecord?.artifactDigest) {
        return { ok: false, reason: 'Artifact record is incomplete.' };
    }

    try {
        const workspaceStat = await stat(artifactRecord.workspacePath);
        if (!workspaceStat.isDirectory()) {
            return { ok: false, reason: 'Validated workspace is missing.' };
        }
    } catch (error) {
        return { ok: false, reason: 'Validated workspace is missing.' };
    }

    const digestResult = await computeDeployableArtifactDigest({
        workspacePath: artifactRecord.workspacePath,
        packageXml: manifest?.packageXml,
        profileOnlyMinimalPackageApplied:
            artifactRecord.profileOnlyMinimalPackageApplied === true,
        autoExcludeShapeFormulaConflicts:
            artifactRecord.autoExcludeShapeFormulaConflicts,
        destinationOrgId: artifactRecord.destinationOrgId,
        deploymentApiVersion:
            manifest?.summary?.apiVersion ||
            manifest?.deploymentApiVersionPolicy?.deploymentApiVersion ||
            null
    });

    if (digestResult.digest !== artifactRecord.artifactDigest) {
        return {
            ok: false,
            reason:
                'Validated workspace or manifest no longer matches the recorded artifact identity.'
        };
    }

    return { ok: true, reason: null };
}

function verifyDestinationOrgIdentity(artifactRecord, orgId) {
    const expected = artifactRecord?.destinationOrgId ?? null;
    const actual = orgId ?? null;

    if (!expected || !actual) {
        return {
            ok: false,
            reason: 'Destination org identity is missing for bound deployment.'
        };
    }

    if (String(expected) !== String(actual)) {
        return {
            ok: false,
            reason: 'Destination org does not match the validated artifact.'
        };
    }

    return { ok: true, reason: null };
}

module.exports = {
    ARTIFACT_SCHEMA_VERSION,
    normalizePackageXml,
    listDeployableWorkspaceFiles,
    computeDeployableArtifactDigest,
    buildBoundDeployArtifactRecord,
    verifyWorkspaceArtifactIntegrity,
    verifyDestinationOrgIdentity,
    wasProfileOnlyMinimalPackageApplied
};
