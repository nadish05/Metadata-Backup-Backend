'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const {
    inspectXmlStructure
} = require('./deploymentPermissionSetCompatibility.service');
const {
    resolveProfileWorkspaceRelativePath,
    resolveSafeWorkspaceAbsolutePath,
    sha256Utf8
} = require('./profileWorkspaceCanonicalContent.service');
const profilePermissionSanitizationDiagnosticLog = require('./profilePermissionSanitizationDiagnosticLog.service');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

const UNKNOWN_USER_PERMISSION_PROBLEM_PATTERN =
    /^Unknown user permission:\s*([A-Za-z0-9_]+)\s*\.?$/;
const PERMISSION_API_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const USER_PERMISSIONS_BLOCK_PATTERN =
    /<userPermissions\b[^>]*>([\s\S]*?)<\/userPermissions>/gi;

function normalizeMetadataType(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function parseUnknownUserPermissionProblem(problem) {
    if (typeof problem !== 'string' || !problem.trim()) {
        return null;
    }

    const match = problem.trim().match(UNKNOWN_USER_PERMISSION_PROBLEM_PATTERN);

    if (!match) {
        return null;
    }

    const permissionName = match[1];

    if (!PERMISSION_API_NAME_PATTERN.test(permissionName)) {
        return null;
    }

    return permissionName;
}

function resolveFailureProfileName(failure) {
    if (normalizeMetadataType(failure?.metadataType) !== 'profile') {
        return null;
    }

    const metadataName =
        typeof failure?.metadataName === 'string'
            ? failure.metadataName.trim()
            : '';
    const fullName =
        typeof failure?.fullName === 'string' ? failure.fullName.trim() : '';

    return metadataName || fullName || null;
}

function isConfirmedUnknownUserPermissionFailure(failure, selectedProfileNames) {
    const profileName = resolveFailureProfileName(failure);

    if (!profileName) {
        return {
            ok: false,
            reason: 'Profile identity is missing from check-only failure.'
        };
    }

    if (
        selectedProfileNames &&
        !selectedProfileNames.has(profileName)
    ) {
        return {
            ok: false,
            reason: `Check-only failure references unselected Profile "${profileName}".`
        };
    }

    const permissionName = parseUnknownUserPermissionProblem(failure?.problem);

    if (!permissionName) {
        return {
            ok: false,
            reason: 'Check-only failure is not a confirmed unknown user permission message.'
        };
    }

    return {
        ok: true,
        profileName,
        permissionName
    };
}

function classifyComponentFailureForDiagnosticLog(failure, selectedProfileNames) {
    const confirmed = isConfirmedUnknownUserPermissionFailure(
        failure,
        selectedProfileNames
    );

    if (confirmed.ok) {
        return 'CONFIRMED_UNKNOWN_USER_PERMISSION';
    }

    if (normalizeMetadataType(failure?.metadataType) !== 'profile') {
        return 'OTHER_FAILURE';
    }

    if (!resolveFailureProfileName(failure)) {
        return 'OTHER_FAILURE';
    }

    return 'UNRECOGNIZED_FAILURE';
}

function extractComponentFailures(checkOnlyResult) {
    const failures =
        checkOnlyResult?.deploymentDiagnostics?.componentFailures;

    if (!Array.isArray(failures)) {
        return null;
    }

    return failures;
}

function extractConfirmedUnknownUserPermissionFailures(
    checkOnlyResult,
    selectedProfileNames
) {
    const componentFailures = extractComponentFailures(checkOnlyResult);

    if (componentFailures === null) {
        return {
            ok: false,
            reason: 'Check-only deployment diagnostics are unavailable.',
            failures: []
        };
    }

    if (!componentFailures.length) {
        return {
            ok: false,
            reason: 'Check-only failed without structured component failures.',
            failures: []
        };
    }

    const confirmed = [];

    for (const failure of componentFailures) {
        const parsed = isConfirmedUnknownUserPermissionFailure(
            failure,
            selectedProfileNames
        );

        if (!parsed.ok) {
            return {
                ok: false,
                reason: parsed.reason,
                failures: []
            };
        }

        confirmed.push({
            profileName: parsed.profileName,
            permissionName: parsed.permissionName,
            sourceFailure: {
                problem: failure?.problem || null,
                metadataType: failure?.metadataType || null,
                metadataName: failure?.metadataName || null,
                fullName: failure?.fullName || null,
                rawFailure: failure?.rawFailure || null
            }
        });
    }

    return {
        ok: true,
        reason: null,
        failures: confirmed
    };
}

function parseProfileUserPermissionBlocks(profileXml) {
    const blocks = [];
    const source = String(profileXml || '');
    let match;

    USER_PERMISSIONS_BLOCK_PATTERN.lastIndex = 0;

    while ((match = USER_PERMISSIONS_BLOCK_PATTERN.exec(source)) !== null) {
        const inner = match[1] || '';
        const nameMatch = inner.match(/<name>\s*([^<]+?)\s*<\/name>/i);
        const enabledMatch = inner.match(/<enabled>\s*(true|false)\s*<\/enabled>/i);
        const enabledValue = enabledMatch?.[1]?.trim().toLowerCase();

        blocks.push({
            fullBlock: match[0],
            start: match.index,
            end: match.index + match[0].length,
            name: nameMatch?.[1]?.trim() || null,
            enabled: enabledValue === 'true',
            enabledPresent: enabledValue === 'true' || enabledValue === 'false'
        });
    }

    return blocks;
}

function analyzePermissionBlockMatch(blocks, permissionName) {
    const matching = blocks.filter((block) => block.name === permissionName);
    const enabledTrue = matching.filter((block) => block.enabled === true);
    const enabledFalse = matching.filter(
        (block) => block.enabledPresent && block.enabled === false
    );

    return {
        matching,
        enabledTrue,
        enabledFalse
    };
}

function removeSingleUserPermissionBlock(profileXml, permissionName) {
    const blocks = parseProfileUserPermissionBlocks(profileXml);
    const analysis = analyzePermissionBlockMatch(blocks, permissionName);

    if (!analysis.matching.length) {
        return {
            ok: false,
            reason: `Permission "${permissionName}" was not found in Profile XML.`
        };
    }

    if (analysis.enabledFalse.length) {
        return {
            ok: false,
            reason: `Permission "${permissionName}" exists with enabled=false and cannot be sanitized.`
        };
    }

    if (analysis.enabledTrue.length !== 1) {
        return {
            ok: false,
            reason: `Permission "${permissionName}" is ambiguous in Profile XML.`
        };
    }

    const target = analysis.enabledTrue[0];
    const updatedXml =
        profileXml.slice(0, target.start) + profileXml.slice(target.end);

    return {
        ok: true,
        xml: updatedXml,
        removedBlock: target.fullBlock
    };
}

function validateSanitizedProfileXml(profileXml) {
    inspectXmlStructure(profileXml, { expectedRoot: 'Profile' });
}

function buildSelectedProfileNameSet(generatedDeploymentPackage) {
    const names = new Set();

    for (const item of generatedDeploymentPackage?.metadata || []) {
        if (item?.metadataType === 'Profile' && item?.metadataName) {
            names.add(String(item.metadataName).trim());
        }
    }

    return names;
}

function emptyProfilePermissionSanitization(overrides = {}) {
    return {
        status: 'NOT_EXECUTED',
        overallStatus: 'PASS',
        checkOnlyAttempts: 0,
        removedCount: 0,
        removedPermissions: [],
        profiles: [],
        warnings: [],
        errors: [],
        ...overrides
    };
}

async function applySanitizationPlan({
    workspacePath,
    confirmedFailures,
    attempt,
    deploymentId = null,
    validationId = null,
    profileWorkspaceProfiles = null
}) {
    const removedPermissions = [];
    const byProfile = new Map();

    for (const failure of confirmedFailures) {
        const key = failure.profileName;

        if (!byProfile.has(key)) {
            byProfile.set(key, new Set());
        }

        byProfile.get(key).add(failure.permissionName);
    }

    for (const [profileName, permissionNames] of byProfile.entries()) {
        const workspaceRelativePath =
            resolveProfileWorkspaceRelativePath(profileName);
        const absolutePath = resolveSafeWorkspaceAbsolutePath(
            workspacePath,
            workspaceRelativePath
        );
        let profileXml = await readFile(absolutePath, 'utf8');
        const originalXml = profileXml;
        const workspaceProfileRecord = (profileWorkspaceProfiles || []).find(
            (entry) => entry.profileName === profileName
        );
        const originalCanonicalSha256 =
            workspaceProfileRecord?.originalCanonicalSha256 ||
            workspaceProfileRecord?.canonicalSha256 ||
            sha256Utf8(originalXml);

        for (const permissionName of permissionNames) {
            const matchingFailure = confirmedFailures.find(
                (entry) =>
                    entry.profileName === profileName &&
                    entry.permissionName === permissionName
            );
            const blocks = parseProfileUserPermissionBlocks(profileXml);
            const analysis = analyzePermissionBlockMatch(blocks, permissionName);

            profilePermissionSanitizationDiagnosticLog.logSanitizationAnalysis({
                validationId,
                attempt,
                profileName,
                permissionName,
                matchCount: analysis.matching.length,
                enabledTrueCount: analysis.enabledTrue.length,
                enabledFalseCount: analysis.enabledFalse.length,
                originalEnabled:
                    analysis.enabledTrue.length === 1 ? true : null,
                eligible: analysis.enabledTrue.length === 1,
                blockReason:
                    analysis.enabledTrue.length === 1
                        ? null
                        : analysis.matching.length
                          ? analysis.enabledFalse.length
                              ? `Permission "${permissionName}" exists with enabled=false.`
                              : `Permission "${permissionName}" is ambiguous in Profile XML.`
                          : `Permission "${permissionName}" was not found in Profile XML.`
            });

            const removal = removeSingleUserPermissionBlock(
                profileXml,
                permissionName
            );

            if (!removal.ok) {
                profilePermissionSanitizationDiagnosticLog.logWorkspaceModification(
                    {
                        validationId,
                        attempt,
                        profileName,
                        success: false,
                        removedPermissionNames: removedPermissions.map(
                            (entry) => entry.permissionName
                        ),
                        originalCanonicalSha256,
                        finalWorkspaceSha256: null,
                        readBackVerification: 'NOT_EXECUTED',
                        workspaceIntegrityStatus: 'BLOCKED',
                        blockReason: removal.reason
                    }
                );

                return {
                    ok: false,
                    reason: removal.reason,
                    removedPermissions
                };
            }

            profileXml = removal.xml;
            removedPermissions.push({
                profileName,
                permissionName,
                originalEnabled: true,
                classification: 'CONFIRMED_UNSUPPORTED',
                reason: 'Rejected by Salesforce check-only deployment',
                sourceFailure: {
                    problem:
                        matchingFailure?.sourceFailure?.problem ||
                        `Unknown user permission: ${permissionName}`,
                    deploymentId: deploymentId || null
                },
                attempt
            });
        }

        try {
            validateSanitizedProfileXml(profileXml);
        } catch (error) {
            profilePermissionSanitizationDiagnosticLog.logWorkspaceModification({
                validationId,
                attempt,
                profileName,
                success: false,
                removedPermissionNames: [],
                originalCanonicalSha256,
                finalWorkspaceSha256: null,
                readBackVerification: 'NOT_EXECUTED',
                workspaceIntegrityStatus: 'BLOCKED',
                blockReason: error?.message || null
            });

            return {
                ok: false,
                reason:
                    error?.message ||
                    `Sanitized Profile XML for "${profileName}" is invalid.`,
                removedPermissions: []
            };
        }

        if (profileXml === originalXml) {
            profilePermissionSanitizationDiagnosticLog.logWorkspaceModification({
                validationId,
                attempt,
                profileName,
                success: false,
                removedPermissionNames: [],
                originalCanonicalSha256,
                finalWorkspaceSha256: null,
                readBackVerification: 'NOT_EXECUTED',
                workspaceIntegrityStatus: 'BLOCKED',
                blockReason: `No Profile XML changes were applied for "${profileName}".`
            });

            return {
                ok: false,
                reason: `No Profile XML changes were applied for "${profileName}".`,
                removedPermissions: []
            };
        }

        try {
            await mkdir(path.dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, profileXml, 'utf8');
            const readBack = await readFile(absolutePath, 'utf8');
            const finalWorkspaceSha256 = sha256Utf8(readBack);
            const writtenSha256 = sha256Utf8(profileXml);

            if (finalWorkspaceSha256 !== writtenSha256) {
                profilePermissionSanitizationDiagnosticLog.logWorkspaceModification(
                    {
                        validationId,
                        attempt,
                        profileName,
                        success: false,
                        removedPermissionNames: [...permissionNames],
                        originalCanonicalSha256,
                        finalWorkspaceSha256,
                        readBackVerification: 'HASH_MISMATCH',
                        workspaceIntegrityStatus: 'BLOCKED',
                        blockReason: `Sanitized Profile read-back verification failed for "${profileName}".`
                    }
                );

                return {
                    ok: false,
                    reason: `Sanitized Profile read-back verification failed for "${profileName}".`,
                    removedPermissions: []
                };
            }

            const postBlocks = parseProfileUserPermissionBlocks(readBack);

            for (const permissionName of permissionNames) {
                const analysis = analyzePermissionBlockMatch(
                    postBlocks,
                    permissionName
                );

                if (analysis.matching.length) {
                    profilePermissionSanitizationDiagnosticLog.logWorkspaceModification(
                        {
                            validationId,
                            attempt,
                            profileName,
                            success: false,
                            removedPermissionNames: [...permissionNames],
                            originalCanonicalSha256,
                            finalWorkspaceSha256,
                            readBackVerification: 'FAILED',
                            workspaceIntegrityStatus: 'BLOCKED',
                            blockReason: `Permission "${permissionName}" remains in Profile "${profileName}" after sanitization.`
                        }
                    );

                    return {
                        ok: false,
                        reason: `Permission "${permissionName}" remains in Profile "${profileName}" after sanitization.`,
                        removedPermissions: []
                    };
                }
            }

            profilePermissionSanitizationDiagnosticLog.logWorkspaceModification({
                validationId,
                attempt,
                profileName,
                success: true,
                removedPermissionNames: [...permissionNames],
                originalCanonicalSha256,
                finalWorkspaceSha256,
                readBackVerification: 'PASSED',
                workspaceIntegrityStatus: 'VERIFIED'
            });
        } catch (error) {
            profilePermissionSanitizationDiagnosticLog.logWorkspaceModification({
                validationId,
                attempt,
                profileName,
                success: false,
                removedPermissionNames: removedPermissions.map(
                    (entry) => entry.permissionName
                ),
                originalCanonicalSha256,
                finalWorkspaceSha256: null,
                readBackVerification: 'FAILED',
                workspaceIntegrityStatus: 'BLOCKED',
                blockReason: error?.message || null
            });

            return {
                ok: false,
                reason:
                    error?.message ||
                    `Sanitized Profile workspace update failed for "${profileName}".`,
                removedPermissions: []
            };
        }
    }

    return {
        ok: true,
        removedPermissions
    };
}

async function refreshFinalWorkspaceHashes(profileWorkspaceContent, workspacePath) {
    const profiles = [];

    for (const profile of profileWorkspaceContent?.profiles || []) {
        const absolutePath = resolveSafeWorkspaceAbsolutePath(
            workspacePath,
            profile.workspaceRelativePath
        );
        const readBack = await readFile(absolutePath, 'utf8');
        const finalWorkspaceSha256 = sha256Utf8(readBack);
        const originalCanonicalSha256 =
            profile.originalCanonicalSha256 ||
            profile.canonicalSha256 ||
            finalWorkspaceSha256;

        profiles.push({
            ...profile,
            originalCanonicalSha256,
            finalWorkspaceSha256,
            workspaceSha256: finalWorkspaceSha256,
            canonicalSha256: finalWorkspaceSha256,
            sanitized: profile.sanitized === true,
            verified: true
        });
    }

    return {
        ...profileWorkspaceContent,
        profiles
    };
}

module.exports = {
    UNKNOWN_USER_PERMISSION_PROBLEM_PATTERN,
    parseUnknownUserPermissionProblem,
    resolveFailureProfileName,
    isConfirmedUnknownUserPermissionFailure,
    classifyComponentFailureForDiagnosticLog,
    extractComponentFailures,
    extractConfirmedUnknownUserPermissionFailures,
    parseProfileUserPermissionBlocks,
    analyzePermissionBlockMatch,
    removeSingleUserPermissionBlock,
    validateSanitizedProfileXml,
    buildSelectedProfileNameSet,
    emptyProfilePermissionSanitization,
    applySanitizationPlan,
    refreshFinalWorkspaceHashes
};
