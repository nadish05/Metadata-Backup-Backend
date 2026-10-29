'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const { getMetadataTypeRule } = require('../config/metadataTypes');
const { orgIdsMatch } = require('./deploymentOrgLock/destinationOrgIdentity.service');

const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const stat = util.promisify(fs.stat);
const lstat = util.promisify(fs.lstat);
const realpath = util.promisify(fs.realpath);

const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Digest inputs (deterministic, server-computed):
 * - schemaVersion
 * - profileOnlyMinimalPackageApplied (boolean)
 * - autoExcludeShapeFormulaConflicts (boolean|null)
 * - destinationOrgId (string|null)
 * - deploymentApiVersion (from manifest summary/policy)
 * - canonicalWorkspaceRoot (realpath)
 * - packageXmlSha256 (normalized LF, trimmed on-disk package.xml only for bound verify)
 * - deployableFiles: sorted relative paths under workspace with sha256 per file
 *   (excludes .sf/, .sfdx/, sfdx-project.json — CLI/bootstrap noise)
 */

const EXCLUDED_RELATIVE_PREFIXES = ['.sf/', '.sfdx/'];
const EXCLUDED_RELATIVE_FILES = new Set(['sfdx-project.json']);
const PACKAGE_XML_RELATIVE = 'package.xml';

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

function isPathInsideRoot(resolvedPath, rootPath) {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedTarget = path.resolve(resolvedPath);
    const relative = path.relative(normalizedRoot, normalizedTarget);

    return (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ''
            ? true
            : normalizedTarget === normalizedRoot
    );
}

async function resolveCanonicalWorkspaceRoot(workspacePath) {
    if (!workspacePath) {
        return null;
    }

    try {
        const resolved = await realpath(path.resolve(workspacePath));
        const workspaceStat = await stat(resolved);

        if (!workspaceStat.isDirectory()) {
            return null;
        }

        return resolved;
    } catch (error) {
        return null;
    }
}

async function listDeployableWorkspaceFiles(workspacePath, options = {}) {
    const { rejectSymlinks = false, canonicalRoot = null } = options;
    const files = [];
    const root = canonicalRoot || path.resolve(workspacePath);

    async function walk(relativeDir) {
        const absoluteDir = relativeDir
            ? path.join(workspacePath, relativeDir)
            : workspacePath;
        const entries = await readdir(absoluteDir, { withFileTypes: true });

        for (const entry of entries) {
            const relativePath = relativeDir
                ? `${relativeDir}/${entry.name}`.replace(/\\/g, '/')
                : entry.name;

            const absolutePath = path.join(workspacePath, relativePath);

            if (rejectSymlinks) {
                const entryStat = await lstat(absolutePath);

                if (entryStat.isSymbolicLink()) {
                    throw new Error(
                        `Symlinks are not permitted in the deployment workspace: ${relativePath}`
                    );
                }
            }

            if (entry.isDirectory()) {
                if (
                    relativePath === '.sf' ||
                    relativePath === '.sfdx' ||
                    relativePath.startsWith('.sf/') ||
                    relativePath.startsWith('.sfdx/')
                ) {
                    continue;
                }

                if (rejectSymlinks) {
                    const resolvedDir = await realpath(absolutePath);
                    if (!isPathInsideRoot(resolvedDir, root)) {
                        throw new Error(
                            `Workspace path escapes approved root: ${relativePath}`
                        );
                    }
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

            if (rejectSymlinks) {
                const resolvedFile = await realpath(absolutePath);
                if (!isPathInsideRoot(resolvedFile, root)) {
                    throw new Error(
                        `Deployable file resolves outside workspace root: ${relativePath}`
                    );
                }
            }

            files.push(relativePath);
        }
    }

    await walk('');
    files.sort((a, b) => a.localeCompare(b));
    return files;
}

function extractManifestMembersByType(packageXml) {
    const membersByType = new Map();
    const normalized = normalizePackageXml(packageXml);
    const typeBlocks = normalized.match(/<types>[\s\S]*?<\/types>/gi) || [];

    for (const block of typeBlocks) {
        const nameMatch = block.match(/<name>\s*([^<]+?)\s*<\/name>/i);
        const metadataType = nameMatch?.[1]?.trim();

        if (!metadataType) {
            continue;
        }

        const members = [...block.matchAll(/<members>\s*([^<]*?)\s*<\/members>/gi)]
            .map((match) => match[1]?.trim())
            .filter(Boolean);

        if (!membersByType.has(metadataType)) {
            membersByType.set(metadataType, new Set());
        }

        for (const member of members) {
            membersByType.get(metadataType).add(member);
        }
    }

    return membersByType;
}

function resolveExpectedMetadataRelativePath(metadataType, metadataName) {
    const rule = getMetadataTypeRule(metadataType);

    if (!rule || !metadataName) {
        return null;
    }

    const folder = rule.folder || `${metadataType.charAt(0).toLowerCase()}${metadataType.slice(1)}s`;
    const extension = rule.extension;

    if (!extension) {
        return null;
    }

    if (metadataType === 'CustomObject') {
        return `objects/${metadataName}/${metadataName}${extension}`;
    }

    return `${folder}/${metadataName}${extension}`;
}

function verifyGeneratedPackageMatchesManifest(manifestPackageXml, generatedPackage) {
    const manifestMembers = extractManifestMembersByType(manifestPackageXml);
    const metadata = generatedPackage?.metadata;

    if (!Array.isArray(metadata) || metadata.length === 0) {
        return { ok: false, reason: 'Generated deployment package metadata is missing.' };
    }

    for (const item of metadata) {
        const metadataType = item?.metadataType;
        const metadataName = item?.metadataName;

        if (!metadataType || !metadataName) {
            return {
                ok: false,
                reason: 'Generated deployment package metadata entry is incomplete.'
            };
        }

        const typeMembers = manifestMembers.get(metadataType);

        if (!typeMembers || !typeMembers.has(metadataName)) {
            return {
                ok: false,
                reason: `Manifest is missing package member ${metadataType}:${metadataName}.`
            };
        }
    }

    for (const [metadataType, memberSet] of manifestMembers.entries()) {
        for (const memberName of memberSet) {
            const stillSelected = metadata.some(
                (item) =>
                    item?.metadataType === metadataType &&
                    item?.metadataName === memberName
            );

            if (!stillSelected) {
                return {
                    ok: false,
                    reason: `Manifest member ${metadataType}:${memberName} is not present in the generated artifact.`
                };
            }
        }
    }

    return { ok: true, reason: null };
}

async function readRequiredPackageXml(workspacePath, { allowManifestFallback = false, manifestPackageXml = null } = {}) {
    const packageXmlPath = path.join(workspacePath, PACKAGE_XML_RELATIVE);

    try {
        return {
            ok: true,
            content: await readFile(packageXmlPath, 'utf8'),
            source: 'disk'
        };
    } catch (error) {
        if (allowManifestFallback && typeof manifestPackageXml === 'string') {
            return {
                ok: true,
                content: manifestPackageXml,
                source: 'manifest_fallback'
            };
        }

        return {
            ok: false,
            reason: 'package.xml is missing from the validated workspace.'
        };
    }
}

async function computeDeployableArtifactDigest({
    workspacePath,
    manifestPackageXml = null,
    profileOnlyMinimalPackageApplied,
    autoExcludeShapeFormulaConflicts,
    destinationOrgId,
    deploymentApiVersion,
    canonicalWorkspaceRoot = null,
    allowManifestFallback = false,
    rejectSymlinks = false
}) {
    const canonicalRoot =
        canonicalWorkspaceRoot ||
        (await resolveCanonicalWorkspaceRoot(workspacePath));

    if (!canonicalRoot) {
        throw new Error('Unable to resolve canonical workspace root.');
    }

    const packageXmlRead = await readRequiredPackageXml(workspacePath, {
        allowManifestFallback,
        manifestPackageXml
    });

    if (!packageXmlRead.ok) {
        throw new Error(packageXmlRead.reason);
    }

    const normalizedXml = normalizePackageXml(packageXmlRead.content);
    const packageXmlSha256 = sha256String(normalizedXml);
    const deployableFiles = [];

    for (const relativePath of await listDeployableWorkspaceFiles(
        workspacePath,
        {
            rejectSymlinks,
            canonicalRoot: canonicalRoot
        }
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
        canonicalWorkspaceRoot: canonicalRoot,
        packageXmlSha256,
        deployableFiles
    };

    return {
        digest: sha256String(JSON.stringify(canonicalPayload)),
        packageXmlSha256,
        deployableFileCount: deployableFiles.length,
        canonicalPayload,
        packageXmlOnDisk: packageXmlRead.content,
        canonicalWorkspaceRoot: canonicalRoot
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

    let digestResult;

    try {
        digestResult = await computeDeployableArtifactDigest({
            workspacePath: generatedWorkspace.workspacePath,
            manifestPackageXml: generatedManifest?.packageXml,
            profileOnlyMinimalPackageApplied: true,
            autoExcludeShapeFormulaConflicts:
                deploymentPackage?.autoExcludeShapeFormulaConflicts,
            destinationOrgId: orgId ?? null,
            deploymentApiVersion,
            allowManifestFallback: false,
            rejectSymlinks: true
        });
    } catch (error) {
        return null;
    }

    const manifestConsistency = verifyGeneratedPackageMatchesManifest(
        digestResult.packageXmlOnDisk,
        generatedPackage
    );

    if (!manifestConsistency.ok) {
        return null;
    }

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
        workspacePath: digestResult.canonicalWorkspaceRoot,
        canonicalWorkspaceRoot: digestResult.canonicalWorkspaceRoot,
        artifactDigest: digestResult.digest,
        packageXmlSha256: digestResult.packageXmlSha256,
        deployableFileCount: digestResult.deployableFileCount,
        recordedAt: new Date().toISOString(),
        checkOnlyDeploymentId: checkOnlyDeployment?.deploymentId || null
    };
}

async function verifyBoundDeployArtifactIntegrity({
    artifactRecord,
    manifest,
    generatedDeploymentPackage,
    strict = true
}) {
    if (
        !artifactRecord?.artifactDigest ||
        !artifactRecord?.canonicalWorkspaceRoot
    ) {
        return { ok: false, reason: 'Artifact record is incomplete.' };
    }

    const workspacePath = artifactRecord.canonicalWorkspaceRoot;

    const currentRoot = await resolveCanonicalWorkspaceRoot(workspacePath);

    if (!currentRoot) {
        return { ok: false, reason: 'Validated workspace is missing.' };
    }

    if (
        path.resolve(currentRoot) !==
        path.resolve(artifactRecord.canonicalWorkspaceRoot)
    ) {
        return {
            ok: false,
            reason: 'Validated workspace root does not match the recorded artifact.'
        };
    }

    let digestResult;

    try {
        digestResult = await computeDeployableArtifactDigest({
            workspacePath: currentRoot,
            manifestPackageXml: manifest?.packageXml,
            profileOnlyMinimalPackageApplied:
                artifactRecord.profileOnlyMinimalPackageApplied === true,
            autoExcludeShapeFormulaConflicts:
                artifactRecord.autoExcludeShapeFormulaConflicts,
            destinationOrgId: artifactRecord.destinationOrgId,
            deploymentApiVersion:
                manifest?.summary?.apiVersion ||
                manifest?.deploymentApiVersionPolicy?.deploymentApiVersion ||
                null,
            canonicalWorkspaceRoot: currentRoot,
            allowManifestFallback: strict ? false : true,
            rejectSymlinks: strict
        });
    } catch (error) {
        return {
            ok: false,
            reason: error.message || 'Artifact integrity verification failed.'
        };
    }

    if (digestResult.digest !== artifactRecord.artifactDigest) {
        return {
            ok: false,
            reason:
                'Validated workspace or manifest no longer matches the recorded artifact identity.'
        };
    }

    const manifestConsistency = verifyGeneratedPackageMatchesManifest(
        digestResult.packageXmlOnDisk,
        generatedDeploymentPackage
    );

    if (!manifestConsistency.ok) {
        return manifestConsistency;
    }

    for (const item of generatedDeploymentPackage?.metadata || []) {
        const relativePath = resolveExpectedMetadataRelativePath(
            item.metadataType,
            item.metadataName
        );

        if (!relativePath) {
            return {
                ok: false,
                reason: `Unable to resolve deployable path for ${item.metadataType}:${item.metadataName}.`
            };
        }

        const absolutePath = path.join(currentRoot, relativePath);

        try {
            const fileStat = await lstat(absolutePath);

            if (fileStat.isSymbolicLink()) {
                return {
                    ok: false,
                    reason: `Deployable file must not be a symlink: ${relativePath}`
                };
            }

            if (!fileStat.isFile()) {
                return {
                    ok: false,
                    reason: `Required deployable file is missing: ${relativePath}`
                };
            }

            const resolvedFile = await realpath(absolutePath);

            if (!isPathInsideRoot(resolvedFile, currentRoot)) {
                return {
                    ok: false,
                    reason: `Deployable file resolves outside workspace: ${relativePath}`
                };
            }
        } catch (error) {
            return {
                ok: false,
                reason: `Required deployable file is missing: ${relativePath}`
            };
        }
    }

    return {
        ok: true,
        reason: null,
        canonicalWorkspaceRoot: currentRoot,
        packageXmlOnDisk: digestResult.packageXmlOnDisk
    };
}

function verifyArtifactDestinationOrgIdentity(artifactRecord, verifiedOrgId) {
    const expected = artifactRecord?.destinationOrgId ?? null;

    if (!expected || !verifiedOrgId) {
        return {
            ok: false,
            reason: 'Destination org identity is missing for bound deployment.'
        };
    }

    if (!orgIdsMatch(expected, verifiedOrgId)) {
        return {
            ok: false,
            reason:
                'Authenticated destination org does not match the validated artifact.'
        };
    }

    return { ok: true, reason: null };
}

/** @deprecated Use verifyArtifactDestinationOrgIdentity with verified org from OAuth. */
function verifyDestinationOrgIdentity(artifactRecord, orgId) {
    return verifyArtifactDestinationOrgIdentity(artifactRecord, orgId);
}

module.exports = {
    ARTIFACT_SCHEMA_VERSION,
    normalizePackageXml,
    listDeployableWorkspaceFiles,
    computeDeployableArtifactDigest,
    buildBoundDeployArtifactRecord,
    verifyBoundDeployArtifactIntegrity,
    verifyWorkspaceArtifactIntegrity: verifyBoundDeployArtifactIntegrity,
    verifyArtifactDestinationOrgIdentity,
    verifyDestinationOrgIdentity,
    verifyGeneratedPackageMatchesManifest,
    resolveCanonicalWorkspaceRoot,
    wasProfileOnlyMinimalPackageApplied
};
