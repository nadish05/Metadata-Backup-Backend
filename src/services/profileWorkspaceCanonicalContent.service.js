'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const deploymentWorkspaceService = require('./deploymentWorkspace.service');
const {
    inspectXmlStructure,
    collectProfileItems
} = require('./deploymentPermissionSetCompatibility.service');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

const PROFILE_FILE_SUFFIX = '.profile-meta.xml';

function normalizeRelativePath(relativePath) {
    return String(relativePath || '').replace(/\\/g, '/');
}

function resolveProfileWorkspaceRelativePath(profileName) {
    const trimmed = String(profileName || '').trim();

    if (!trimmed) {
        throw new Error('Profile name is required for workspace path resolution.');
    }

    return `force-app/main/default/profiles/${trimmed}${PROFILE_FILE_SUFFIX}`;
}

function registerProfileWorkspaceDestination(destinations, profileName) {
    const workspaceRelativePath = resolveProfileWorkspaceRelativePath(profileName);

    if (destinations.has(workspaceRelativePath)) {
        return {
            ok: false,
            reason: `Duplicate workspace destination "${workspaceRelativePath}" for Profile "${profileName}".`
        };
    }

    destinations.set(workspaceRelativePath, profileName);

    return {
        ok: true,
        workspaceRelativePath
    };
}

function sha256Utf8(content) {
    return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function resolveSafeWorkspaceAbsolutePath(workspaceRoot, relativePath) {
    const normalized = normalizeRelativePath(relativePath);

    if (!normalized || normalized.includes('..')) {
        throw new Error('Invalid workspace-relative Profile path.');
    }

    const absolutePath = path.resolve(
        workspaceRoot,
        ...normalized.split('/').filter(Boolean)
    );
    const resolvedRoot = path.resolve(workspaceRoot);

    if (
        absolutePath !== resolvedRoot &&
        !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
        throw new Error('Resolved Profile destination is outside the workspace.');
    }

    return absolutePath;
}

function createWorkspaceFileReader(workspaceRoot) {
    return async (relativePath) => {
        const absolutePath = resolveSafeWorkspaceAbsolutePath(
            workspaceRoot,
            relativePath
        );

        return readFile(absolutePath, 'utf8');
    };
}

function findRepositoryProfilePathCandidates(profileName, repoFiles) {
    const baseName = `${String(profileName).trim()}${PROFILE_FILE_SUFFIX}`;

    return (repoFiles || [])
        .map((repoFile) => normalizeRelativePath(repoFile))
        .filter(
            (repoFile) =>
                path.posix.basename(repoFile) === baseName ||
                repoFile.endsWith(`/${baseName}`)
        );
}

function resolveDeterministicRepositoryProfilePath(
    profileName,
    repoFiles,
    explicitRelativePath = null
) {
    const trimmedName = String(profileName || '').trim();

    if (!trimmedName) {
        return {
            ok: false,
            reason: 'Profile name is required for repository resolution.'
        };
    }

    if (explicitRelativePath) {
        const normalizedExplicit = normalizeRelativePath(explicitRelativePath);
        const matched = (repoFiles || []).some(
            (repoFile) => normalizeRelativePath(repoFile) === normalizedExplicit
        );

        if (!matched) {
            return {
                ok: false,
                reason: `Repository Profile file not found for selected path: ${normalizedExplicit}.`
            };
        }

        if (
            path.posix.basename(normalizedExplicit, PROFILE_FILE_SUFFIX) !==
            trimmedName
        ) {
            return {
                ok: false,
                reason: `Repository Profile path does not match selected Profile "${trimmedName}".`
            };
        }

        return {
            ok: true,
            repositoryRelativePath: normalizedExplicit
        };
    }

    const candidates = findRepositoryProfilePathCandidates(trimmedName, repoFiles);
    const preferredPaths = [
        resolveProfileWorkspaceRelativePath(trimmedName),
        `profiles/${trimmedName}${PROFILE_FILE_SUFFIX}`
    ];
    const preferredMatches = preferredPaths.filter((preferredPath) =>
        candidates.includes(preferredPath)
    );

    if (preferredMatches.length > 1) {
        return {
            ok: false,
            ambiguous: true,
            reason: `Multiple repository Profile paths match Profile "${trimmedName}".`
        };
    }

    if (preferredMatches.length === 1) {
        return {
            ok: true,
            repositoryRelativePath: preferredMatches[0]
        };
    }

    if (candidates.length === 1) {
        return {
            ok: true,
            repositoryRelativePath: candidates[0]
        };
    }

    if (candidates.length > 1) {
        return {
            ok: false,
            ambiguous: true,
            reason: `Multiple repository Profile files match Profile "${trimmedName}".`
        };
    }

    return {
        ok: false,
        reason: `Profile XML for "${trimmedName}" was not found in the repository.`
    };
}

function resolveInlineSelectedProfileContent(deploymentPackage, profileName) {
    const trimmedName = String(profileName || '').trim();

    for (const item of deploymentPackage?.selectedMetadata || []) {
        if (
            item?.metadataType !== 'Profile' ||
            String(item?.metadataName || '').trim() !== trimmedName
        ) {
            continue;
        }

        if (typeof item?.content === 'string' && item.content.trim()) {
            return item.content;
        }
    }

    return null;
}

function resolveExplicitProfileFilePath(deploymentPackage, generatedItem) {
    const profileName = String(generatedItem?.metadataName || '').trim();

    for (const item of deploymentPackage?.selectedMetadata || []) {
        if (
            item?.metadataType === 'Profile' &&
            String(item?.metadataName || '').trim() === profileName &&
            item?.filePath
        ) {
            return normalizeRelativePath(item.filePath);
        }
    }

    if (generatedItem?.filePath) {
        return normalizeRelativePath(generatedItem.filePath);
    }

    return null;
}

async function resolveCanonicalProfileXmlContent({
    profileName,
    deploymentPackage,
    generatedItem,
    readRepositoryFile,
    repoFiles
}) {
    const inlineContent = resolveInlineSelectedProfileContent(
        deploymentPackage,
        profileName
    );

    if (inlineContent) {
        return {
            ok: true,
            source: 'INLINE_SELECTED_CONTENT',
            xml: inlineContent
        };
    }

    if (typeof readRepositoryFile !== 'function') {
        return {
            ok: false,
            reason: 'Repository reader is unavailable for Profile resolution.'
        };
    }

    const explicitRelativePath = resolveExplicitProfileFilePath(
        deploymentPackage,
        generatedItem
    );
    const repositoryResolution = resolveDeterministicRepositoryProfilePath(
        profileName,
        repoFiles,
        explicitRelativePath
    );

    if (!repositoryResolution.ok) {
        return {
            ok: false,
            reason: repositoryResolution.reason,
            ambiguous: repositoryResolution.ambiguous === true
        };
    }

    let xml;

    try {
        xml = await readRepositoryFile(repositoryResolution.repositoryRelativePath);
    } catch (error) {
        return {
            ok: false,
            reason:
                error?.message ||
                `Unable to read repository Profile XML for "${profileName}".`
        };
    }

    if (typeof xml !== 'string' || !xml.trim()) {
        return {
            ok: false,
            reason: `Profile XML for "${profileName}" is empty in the repository.`
        };
    }

    return {
        ok: true,
        source: 'GIT_REPOSITORY',
        xml,
        repositoryRelativePath: repositoryResolution.repositoryRelativePath
    };
}

function buildPackageForWorkspaceProfileInspection(generatedDeploymentPackage) {
    return {
        ...generatedDeploymentPackage,
        metadata: (generatedDeploymentPackage?.metadata || []).map((item) => {
            const profileName = String(item?.metadataName || '').trim();
            const { content, ...rest } = item;

            return {
                ...rest,
                filePath: resolveProfileWorkspaceRelativePath(profileName)
            };
        })
    };
}

async function verifyProfileWorkspaceContentUnchanged(
    workspaceRoot,
    verifiedProfiles
) {
    for (const profile of verifiedProfiles || []) {
        if (!profile?.verified || !profile?.workspaceRelativePath) {
            continue;
        }

        const readBack = await readFile(
            resolveSafeWorkspaceAbsolutePath(
                workspaceRoot,
                profile.workspaceRelativePath
            ),
            'utf8'
        );
        const workspaceSha256 = sha256Utf8(readBack);

        if (workspaceSha256 !== profile.canonicalSha256) {
            return {
                ok: false,
                reason: `Workspace Profile content changed for "${profile.profileName}" before downstream validation.`
            };
        }
    }

    return { ok: true };
}

async function materializeProfileOnlyWorkspaceCanonicalContent({
    workspacePath,
    deploymentPackage,
    generatedDeploymentPackage,
    repoUrl,
    sourceBranch
}) {
    const errors = [];
    const profiles = [];

    if (!workspacePath) {
        return {
            status: 'BLOCKED',
            profiles,
            errors: ['Deployment workspace path is unavailable.']
        };
    }

    let readRepositoryFile = null;
    let repoFiles = [];

    try {
        readRepositoryFile =
            await deploymentWorkspaceService.createRepositoryFileReader(
                repoUrl,
                sourceBranch
            );
        repoFiles =
            await deploymentWorkspaceService.listDeploymentRepositoryRelativeFiles(
                repoUrl,
                sourceBranch
            );
    } catch (error) {
        return {
            status: 'BLOCKED',
            profiles,
            errors: [
                error?.message ||
                    'Unable to prepare repository context for Profile materialization.'
            ]
        };
    }

    const workspaceDestinations = new Map();
    const profileItems = collectProfileItems(generatedDeploymentPackage);

    for (const item of profileItems) {
        const profileName = String(item?.metadataName || '').trim();
        const destinationRegistration = registerProfileWorkspaceDestination(
            workspaceDestinations,
            profileName
        );

        if (!destinationRegistration.ok) {
            errors.push(destinationRegistration.reason);
            continue;
        }

        const workspaceRelativePath = destinationRegistration.workspaceRelativePath;

        const canonicalResolution = await resolveCanonicalProfileXmlContent({
            profileName,
            deploymentPackage,
            generatedItem: item,
            readRepositoryFile,
            repoFiles
        });

        if (!canonicalResolution.ok) {
            errors.push(
                canonicalResolution.reason ||
                    `Unable to resolve canonical Profile XML for "${profileName}".`
            );
            continue;
        }

        try {
            inspectXmlStructure(canonicalResolution.xml, {
                expectedRoot: 'Profile'
            });
        } catch (structureError) {
            errors.push(
                `Profile "${profileName}": ${
                    structureError?.message ||
                    'Canonical Profile XML is structurally invalid.'
                }`
            );
            continue;
        }

        const canonicalSha256 = sha256Utf8(canonicalResolution.xml);

        try {
            const destinationAbsolutePath = resolveSafeWorkspaceAbsolutePath(
                workspacePath,
                workspaceRelativePath
            );
            await mkdir(path.dirname(destinationAbsolutePath), {
                recursive: true
            });
            await writeFile(
                destinationAbsolutePath,
                canonicalResolution.xml,
                'utf8'
            );

            const readBack = await readFile(destinationAbsolutePath, 'utf8');
            const workspaceSha256 = sha256Utf8(readBack);

            if (canonicalSha256 !== workspaceSha256) {
                errors.push(
                    `Profile "${profileName}": workspace read-back hash does not match canonical content.`
                );
                continue;
            }

            profiles.push({
                profileName,
                workspaceRelativePath,
                source: canonicalResolution.source,
                canonicalSha256,
                workspaceSha256,
                verified: true
            });
        } catch (writeError) {
            errors.push(
                writeError?.message ||
                    `Unable to materialize Profile "${profileName}" into the workspace.`
            );
        }
    }

    if (errors.length) {
        return {
            status: 'BLOCKED',
            profiles,
            errors
        };
    }

    if (!profiles.length) {
        return {
            status: 'BLOCKED',
            profiles,
            errors: ['No Profile metadata was materialized into the workspace.']
        };
    }

    return {
        status: 'VERIFIED',
        profiles,
        errors: []
    };
}

module.exports = {
    PROFILE_FILE_SUFFIX,
    resolveProfileWorkspaceRelativePath,
    registerProfileWorkspaceDestination,
    sha256Utf8,
    resolveSafeWorkspaceAbsolutePath,
    createWorkspaceFileReader,
    findRepositoryProfilePathCandidates,
    resolveDeterministicRepositoryProfilePath,
    resolveInlineSelectedProfileContent,
    resolveCanonicalProfileXmlContent,
    buildPackageForWorkspaceProfileInspection,
    verifyProfileWorkspaceContentUnchanged,
    materializeProfileOnlyWorkspaceCanonicalContent
};
