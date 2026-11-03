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
const MANAGE_KNOWLEDGE_IMPORT_EXPORT_PERMISSION =
    'ManageKnowledgeImportExport';
const MANAGE_KNOWLEDGE_DEPENDENCY_PERMISSION_NAMES = Object.freeze([
    'ViewArchivedArticles',
    'ViewDraftArticles'
]);
const MANAGE_KNOWLEDGE_DEPENDENCY_PROBLEM =
    'Permission ManageKnowledgeImportExport depends on permission(s): ViewArchivedArticles, ViewDraftArticles';
const MANAGE_KNOWLEDGE_DEPENDENCY_PROBLEM_PATTERN =
    /^Permission ManageKnowledgeImportExport depends on permission\(s\): ViewArchivedArticles, ViewDraftArticles$/;
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

function parseManageKnowledgeImportExportDependencyProblem(problem) {
    if (typeof problem !== 'string' || !problem.trim()) {
        return null;
    }

    if (problem.trim() !== MANAGE_KNOWLEDGE_DEPENDENCY_PROBLEM) {
        return null;
    }

    return {
        permissionName: MANAGE_KNOWLEDGE_IMPORT_EXPORT_PERMISSION,
        dependencyPermissionNames: [...MANAGE_KNOWLEDGE_DEPENDENCY_PERMISSION_NAMES]
    };
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

function isConfirmedManageKnowledgeDependencyFailure(
    failure,
    selectedProfileNames
) {
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

    const parsed = parseManageKnowledgeImportExportDependencyProblem(
        failure?.problem
    );

    if (!parsed) {
        return {
            ok: false,
            reason:
                'Check-only failure is not a confirmed ManageKnowledgeImportExport dependency message.'
        };
    }

    return {
        ok: true,
        profileName,
        permissionName: parsed.permissionName,
        dependencyPermissionNames: parsed.dependencyPermissionNames
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

    const dependency = isConfirmedManageKnowledgeDependencyFailure(
        failure,
        selectedProfileNames
    );

    if (dependency.ok) {
        return 'CONFIRMED_DEPENDENCY_PERMISSION_DISABLED';
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

function extractConfirmedManageKnowledgeDependencyFailure(
    checkOnlyResult,
    selectedProfileNames
) {
    const componentFailures = extractComponentFailures(checkOnlyResult);

    if (componentFailures === null) {
        return {
            ok: false,
            reason: 'Check-only deployment diagnostics are unavailable.',
            failure: null
        };
    }

    if (componentFailures.length !== 1) {
        return {
            ok: false,
            reason:
                componentFailures.length === 0
                    ? 'Check-only failed without structured component failures.'
                    : 'Check-only dependency sanitization requires exactly one component failure.',
            failure: null
        };
    }

    const parsed = isConfirmedManageKnowledgeDependencyFailure(
        componentFailures[0],
        selectedProfileNames
    );

    if (!parsed.ok) {
        return {
            ok: false,
            reason: parsed.reason,
            failure: null
        };
    }

    return {
        ok: true,
        reason: null,
        failure: {
            profileName: parsed.profileName,
            permissionName: parsed.permissionName,
            dependencyPermissionNames: parsed.dependencyPermissionNames,
            sourceFailure: {
                problem: componentFailures[0]?.problem || null,
                metadataType: componentFailures[0]?.metadataType || null,
                metadataName: componentFailures[0]?.metadataName || null,
                fullName: componentFailures[0]?.fullName || null,
                rawFailure: componentFailures[0]?.rawFailure || null
            }
        }
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

function disableSingleUserPermissionEnabledFlag(profileXml, permissionName) {
    if (permissionName !== MANAGE_KNOWLEDGE_IMPORT_EXPORT_PERMISSION) {
        return {
            ok: false,
            reason: `Permission "${permissionName}" is not eligible for dependency disable sanitization.`
        };
    }

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

    if (!/<enabled>\s*true\s*<\/enabled>/i.test(target.fullBlock)) {
        return {
            ok: false,
            reason: `Permission "${permissionName}" enabled=true block could not be located for disable sanitization.`
        };
    }

    const updatedBlock = target.fullBlock.replace(
        /<enabled>\s*true\s*<\/enabled>/i,
        '<enabled>false</enabled>'
    );

    if (updatedBlock === target.fullBlock) {
        return {
            ok: false,
            reason: `Permission "${permissionName}" enabled value could not be updated.`
        };
    }

    const updatedXml =
        profileXml.slice(0, target.start) +
        updatedBlock +
        profileXml.slice(target.end);

    return {
        ok: true,
        xml: updatedXml,
        updatedBlock,
        originalBlock: target.fullBlock
    };
}

function buildUnrelatedPermissionBlocksFingerprint(profileXml, permissionName) {
    return parseProfileUserPermissionBlocks(profileXml)
        .filter((block) => block.name !== permissionName)
        .map((block) => block.fullBlock)
        .join('');
}

function validateSanitizedProfileXml(profileXml) {
    inspectXmlStructure(profileXml, { expectedRoot: 'Profile' });
}

function buildProfilePermissionRemovalVerification({
    permissionName,
    beforeAnalysis,
    afterAnalysis = null,
    workspaceReadBack = false,
    xmlStructureValid = false,
    workspaceIntegrityVerified = false,
    salesforcePermissionNameMatches = true
}) {
    const matchingBlocksBefore = beforeAnalysis.matching.length;
    const matchingBlocksAfter =
        afterAnalysis === null ? null : afterAnalysis.matching.length;
    const originalBlockFound = beforeAnalysis.enabledTrue.length === 1;
    const originalEnabled = originalBlockFound ? true : null;
    const removedBlockCount = originalBlockFound ? 1 : 0;

    const failureReasons = [];

    if (!originalBlockFound) {
        failureReasons.push(
            `Expected exactly one enabled=true block for "${permissionName}" before removal.`
        );
    }

    if (matchingBlocksBefore !== 1) {
        failureReasons.push(
            `Expected matchingBlocksBefore=1 but found ${matchingBlocksBefore}.`
        );
    }

    if (salesforcePermissionNameMatches === false) {
        failureReasons.push(
            'Permission name does not match the confirmed Salesforce failure.'
        );
    }

    if (afterAnalysis !== null && matchingBlocksAfter !== 0) {
        failureReasons.push(
            `Expected matchingBlocksAfter=0 but found ${matchingBlocksAfter}.`
        );
    }

    if (!workspaceReadBack) {
        failureReasons.push('Workspace Profile read-back did not succeed.');
    }

    if (!xmlStructureValid) {
        failureReasons.push('Sanitized Profile XML structure validation failed.');
    }

    if (!workspaceIntegrityVerified) {
        failureReasons.push('Workspace hash read-back verification failed.');
    }

    const verificationStatus =
        failureReasons.length === 0 ? 'PASSED' : 'FAILED';

    return {
        permissionName,
        originalBlockFound,
        originalEnabled,
        matchingBlocksBefore,
        matchingBlocksAfter,
        removedBlockCount,
        workspaceReadBack,
        xmlStructureValid,
        workspaceIntegrityVerified,
        salesforcePermissionNameMatches,
        verificationStatus,
        failureReason: failureReasons.length ? failureReasons.join(' ') : null
    };
}

function buildProfilePermissionDisableVerification({
    permissionName,
    beforeAnalysis,
    afterAnalysis = null,
    workspaceReadBack = false,
    xmlStructureValid = false,
    workspaceIntegrityVerified = false,
    unrelatedBlocksUnchanged = false,
    salesforcePermissionNameMatches = true
}) {
    const matchingBlocksBefore = beforeAnalysis.matching.length;
    const matchingBlocksAfter =
        afterAnalysis === null ? null : afterAnalysis.matching.length;
    const originalBlockFound = beforeAnalysis.enabledTrue.length === 1;
    const originalEnabled = originalBlockFound ? true : null;
    const finalEnabled =
        afterAnalysis?.enabledFalse?.length === 1 &&
        afterAnalysis.enabledTrue.length === 0
            ? false
            : null;

    const failureReasons = [];

    if (!originalBlockFound) {
        failureReasons.push(
            `Expected exactly one enabled=true block for "${permissionName}" before disable.`
        );
    }

    if (matchingBlocksBefore !== 1) {
        failureReasons.push(
            `Expected matchingBlocksBefore=1 but found ${matchingBlocksBefore}.`
        );
    }

    if (salesforcePermissionNameMatches === false) {
        failureReasons.push(
            'Permission name does not match the confirmed Salesforce failure.'
        );
    }

    if (afterAnalysis !== null) {
        if (matchingBlocksAfter !== 1) {
            failureReasons.push(
                `Expected matchingBlocksAfter=1 but found ${matchingBlocksAfter}.`
            );
        }

        if (afterAnalysis.enabledTrue.length) {
            failureReasons.push(
                `Expected final enabled=false for "${permissionName}" after disable.`
            );
        }
    }

    if (!workspaceReadBack) {
        failureReasons.push('Workspace Profile read-back did not succeed.');
    }

    if (!xmlStructureValid) {
        failureReasons.push('Sanitized Profile XML structure validation failed.');
    }

    if (!workspaceIntegrityVerified) {
        failureReasons.push('Workspace hash read-back verification failed.');
    }

    if (!unrelatedBlocksUnchanged) {
        failureReasons.push(
            'Unrelated Profile userPermissions content changed during disable sanitization.'
        );
    }

    const verificationStatus =
        failureReasons.length === 0 ? 'PASSED' : 'FAILED';

    return {
        permissionName,
        originalBlockFound,
        originalEnabled,
        finalEnabled,
        matchingBlocksBefore,
        matchingBlocksAfter,
        workspaceReadBack,
        xmlStructureValid,
        workspaceIntegrityVerified,
        unrelatedBlocksUnchanged,
        salesforcePermissionNameMatches,
        verificationStatus,
        failureReason: failureReasons.length ? failureReasons.join(' ') : null
    };
}

function emitProfilePermissionRemovalVerifiedDiagnostic({
    validationId,
    attempt,
    profileName,
    verification
}) {
    profilePermissionSanitizationDiagnosticLog.logProfilePermissionRemovalVerified(
        {
            validationId,
            attempt,
            profileName,
            permissionName: verification.permissionName,
            originalBlockFound: verification.originalBlockFound,
            originalEnabled: verification.originalEnabled,
            matchingBlocksBefore: verification.matchingBlocksBefore,
            matchingBlocksAfter: verification.matchingBlocksAfter,
            removedBlockCount: verification.removedBlockCount,
            workspaceReadBack: verification.workspaceReadBack,
            xmlStructureValid: verification.xmlStructureValid,
            workspaceIntegrityVerified: verification.workspaceIntegrityVerified,
            salesforcePermissionNameMatches:
                verification.salesforcePermissionNameMatches,
            verificationStatus: verification.verificationStatus,
            failureReason: verification.failureReason
        }
    );
}

function emitProfilePermissionDisableVerifiedDiagnostic({
    validationId,
    attempt,
    profileName,
    verification
}) {
    profilePermissionSanitizationDiagnosticLog.logProfilePermissionDisableVerified(
        {
            validationId,
            attempt,
            profileName,
            permissionName: verification.permissionName,
            originalBlockFound: verification.originalBlockFound,
            originalEnabled: verification.originalEnabled,
            finalEnabled: verification.finalEnabled,
            matchingBlocksBefore: verification.matchingBlocksBefore,
            matchingBlocksAfter: verification.matchingBlocksAfter,
            workspaceReadBack: verification.workspaceReadBack,
            xmlStructureValid: verification.xmlStructureValid,
            workspaceIntegrityVerified: verification.workspaceIntegrityVerified,
            unrelatedBlocksUnchanged: verification.unrelatedBlocksUnchanged,
            salesforcePermissionNameMatches:
                verification.salesforcePermissionNameMatches,
            verificationStatus: verification.verificationStatus,
            failureReason: verification.failureReason
        }
    );
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
        disabledCount: 0,
        disabledPermissions: [],
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
        const originalDiskXml = profileXml;
        const permissionNamesList = [...permissionNames];
        const beforeRemovalAnalyses = new Map();

        for (const permissionName of permissionNamesList) {
            beforeRemovalAnalyses.set(
                permissionName,
                analyzePermissionBlockMatch(
                    parseProfileUserPermissionBlocks(originalDiskXml),
                    permissionName
                )
            );
        }

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
                emitProfilePermissionRemovalVerifiedDiagnostic({
                    validationId,
                    attempt,
                    profileName,
                    verification: buildProfilePermissionRemovalVerification({
                        permissionName,
                        beforeAnalysis: beforeRemovalAnalyses.get(permissionName),
                        afterAnalysis: analyzePermissionBlockMatch(
                            parseProfileUserPermissionBlocks(profileXml),
                            permissionName
                        ),
                        workspaceReadBack: false,
                        xmlStructureValid: false,
                        workspaceIntegrityVerified: false,
                        salesforcePermissionNameMatches:
                            parseUnknownUserPermissionProblem(
                                matchingFailure?.sourceFailure?.problem
                            ) === permissionName
                    })
                });

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

            for (const permissionName of permissionNamesList) {
                const matchingFailure = confirmedFailures.find(
                    (entry) =>
                        entry.profileName === profileName &&
                        entry.permissionName === permissionName
                );
                emitProfilePermissionRemovalVerifiedDiagnostic({
                    validationId,
                    attempt,
                    profileName,
                    verification: buildProfilePermissionRemovalVerification({
                        permissionName,
                        beforeAnalysis: beforeRemovalAnalyses.get(permissionName),
                        afterAnalysis: null,
                        workspaceReadBack: false,
                        xmlStructureValid: false,
                        workspaceIntegrityVerified: false,
                        salesforcePermissionNameMatches:
                            parseUnknownUserPermissionProblem(
                                matchingFailure?.sourceFailure?.problem
                            ) === permissionName
                    })
                });
            }

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

                for (const permissionName of permissionNamesList) {
                    const matchingFailure = confirmedFailures.find(
                        (entry) =>
                            entry.profileName === profileName &&
                            entry.permissionName === permissionName
                    );
                    emitProfilePermissionRemovalVerifiedDiagnostic({
                        validationId,
                        attempt,
                        profileName,
                        verification: buildProfilePermissionRemovalVerification({
                            permissionName,
                            beforeAnalysis:
                                beforeRemovalAnalyses.get(permissionName),
                            afterAnalysis: analyzePermissionBlockMatch(
                                parseProfileUserPermissionBlocks(readBack),
                                permissionName
                            ),
                            workspaceReadBack: true,
                            xmlStructureValid: true,
                            workspaceIntegrityVerified: false,
                            salesforcePermissionNameMatches:
                                parseUnknownUserPermissionProblem(
                                    matchingFailure?.sourceFailure?.problem
                                ) === permissionName
                        })
                    });
                }

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
                    const matchingFailure = confirmedFailures.find(
                        (entry) =>
                            entry.profileName === profileName &&
                            entry.permissionName === permissionName
                    );
                    emitProfilePermissionRemovalVerifiedDiagnostic({
                        validationId,
                        attempt,
                        profileName,
                        verification: buildProfilePermissionRemovalVerification({
                            permissionName,
                            beforeAnalysis:
                                beforeRemovalAnalyses.get(permissionName),
                            afterAnalysis: analysis,
                            workspaceReadBack: true,
                            xmlStructureValid: true,
                            workspaceIntegrityVerified: true,
                            salesforcePermissionNameMatches:
                                parseUnknownUserPermissionProblem(
                                    matchingFailure?.sourceFailure?.problem
                                ) === permissionName
                        })
                    });

                    return {
                        ok: false,
                        reason: `Permission "${permissionName}" remains in Profile "${profileName}" after sanitization.`,
                        removedPermissions: []
                    };
                }
            }

            for (const permissionName of permissionNamesList) {
                const matchingFailure = confirmedFailures.find(
                    (entry) =>
                        entry.profileName === profileName &&
                        entry.permissionName === permissionName
                );
                emitProfilePermissionRemovalVerifiedDiagnostic({
                    validationId,
                    attempt,
                    profileName,
                    verification: buildProfilePermissionRemovalVerification({
                        permissionName,
                        beforeAnalysis: beforeRemovalAnalyses.get(permissionName),
                        afterAnalysis: analyzePermissionBlockMatch(
                            postBlocks,
                            permissionName
                        ),
                        workspaceReadBack: true,
                        xmlStructureValid: true,
                        workspaceIntegrityVerified: true,
                        salesforcePermissionNameMatches:
                            parseUnknownUserPermissionProblem(
                                matchingFailure?.sourceFailure?.problem
                            ) === permissionName
                    })
                });
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

            for (const permissionName of permissionNamesList) {
                const matchingFailure = confirmedFailures.find(
                    (entry) =>
                        entry.profileName === profileName &&
                        entry.permissionName === permissionName
                );
                emitProfilePermissionRemovalVerifiedDiagnostic({
                    validationId,
                    attempt,
                    profileName,
                    verification: buildProfilePermissionRemovalVerification({
                        permissionName,
                        beforeAnalysis: beforeRemovalAnalyses.get(permissionName),
                        afterAnalysis: null,
                        workspaceReadBack: false,
                        xmlStructureValid: false,
                        workspaceIntegrityVerified: false,
                        salesforcePermissionNameMatches:
                            parseUnknownUserPermissionProblem(
                                matchingFailure?.sourceFailure?.problem
                            ) === permissionName
                    })
                });
            }

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

async function applyDependencyDisablePlan({
    workspacePath,
    confirmedFailure,
    attempt,
    deploymentId = null,
    validationId = null,
    profileWorkspaceProfiles = null
}) {
    const disabledPermissions = [];
    const profileName = confirmedFailure?.profileName;
    const permissionName = confirmedFailure?.permissionName;
    const dependencyPermissionNames =
        confirmedFailure?.dependencyPermissionNames || [];

    if (!profileName || !permissionName) {
        return {
            ok: false,
            reason: 'Confirmed dependency failure is incomplete.',
            disabledPermissions: []
        };
    }

    const workspaceRelativePath =
        resolveProfileWorkspaceRelativePath(profileName);
    const absolutePath = resolveSafeWorkspaceAbsolutePath(
        workspacePath,
        workspaceRelativePath
    );
    const originalDiskXml = await readFile(absolutePath, 'utf8');
    const beforeAnalysis = analyzePermissionBlockMatch(
        parseProfileUserPermissionBlocks(originalDiskXml),
        permissionName
    );
    const unrelatedBlocksBefore = buildUnrelatedPermissionBlocksFingerprint(
        originalDiskXml,
        permissionName
    );
    const workspaceProfileRecord = (profileWorkspaceProfiles || []).find(
        (entry) => entry.profileName === profileName
    );
    const originalCanonicalSha256 =
        workspaceProfileRecord?.originalCanonicalSha256 ||
        workspaceProfileRecord?.canonicalSha256 ||
        sha256Utf8(originalDiskXml);

    profilePermissionSanitizationDiagnosticLog.logSanitizationAnalysis({
        validationId,
        attempt,
        profileName,
        permissionName,
        matchCount: beforeAnalysis.matching.length,
        enabledTrueCount: beforeAnalysis.enabledTrue.length,
        enabledFalseCount: beforeAnalysis.enabledFalse.length,
        originalEnabled:
            beforeAnalysis.enabledTrue.length === 1 ? true : null,
        eligible: beforeAnalysis.enabledTrue.length === 1,
        blockReason:
            beforeAnalysis.enabledTrue.length === 1
                ? null
                : beforeAnalysis.matching.length
                  ? beforeAnalysis.enabledFalse.length
                      ? `Permission "${permissionName}" exists with enabled=false.`
                      : `Permission "${permissionName}" is ambiguous in Profile XML.`
                  : `Permission "${permissionName}" was not found in Profile XML.`
    });

    const disableResult = disableSingleUserPermissionEnabledFlag(
        originalDiskXml,
        permissionName
    );

    if (!disableResult.ok) {
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
            blockReason: disableResult.reason
        });
        emitProfilePermissionDisableVerifiedDiagnostic({
            validationId,
            attempt,
            profileName,
            verification: buildProfilePermissionDisableVerification({
                permissionName,
                beforeAnalysis,
                afterAnalysis: analyzePermissionBlockMatch(
                    parseProfileUserPermissionBlocks(originalDiskXml),
                    permissionName
                ),
                workspaceReadBack: false,
                xmlStructureValid: false,
                workspaceIntegrityVerified: false,
                unrelatedBlocksUnchanged: false,
                salesforcePermissionNameMatches:
                    parseManageKnowledgeImportExportDependencyProblem(
                        confirmedFailure?.sourceFailure?.problem
                    )?.permissionName === permissionName
            })
        });

        return {
            ok: false,
            reason: disableResult.reason,
            disabledPermissions: []
        };
    }

    let profileXml = disableResult.xml;

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
        emitProfilePermissionDisableVerifiedDiagnostic({
            validationId,
            attempt,
            profileName,
            verification: buildProfilePermissionDisableVerification({
                permissionName,
                beforeAnalysis,
                afterAnalysis: null,
                workspaceReadBack: false,
                xmlStructureValid: false,
                workspaceIntegrityVerified: false,
                unrelatedBlocksUnchanged: false,
                salesforcePermissionNameMatches:
                    parseManageKnowledgeImportExportDependencyProblem(
                        confirmedFailure?.sourceFailure?.problem
                    )?.permissionName === permissionName
            })
        });

        return {
            ok: false,
            reason:
                error?.message ||
                `Sanitized Profile XML for "${profileName}" is invalid.`,
            disabledPermissions: []
        };
    }

    if (profileXml === originalDiskXml) {
        return {
            ok: false,
            reason: `No Profile XML changes were applied for "${profileName}".`,
            disabledPermissions: []
        };
    }

    const unrelatedBlocksAfterWrite = buildUnrelatedPermissionBlocksFingerprint(
        profileXml,
        permissionName
    );

    if (unrelatedBlocksAfterWrite !== unrelatedBlocksBefore) {
        return {
            ok: false,
            reason: `Unrelated Profile userPermissions changed while disabling "${permissionName}".`,
            disabledPermissions: []
        };
    }

    try {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, profileXml, 'utf8');
        const readBack = await readFile(absolutePath, 'utf8');
        const finalWorkspaceSha256 = sha256Utf8(readBack);
        const writtenSha256 = sha256Utf8(profileXml);

        if (finalWorkspaceSha256 !== writtenSha256) {
            emitProfilePermissionDisableVerifiedDiagnostic({
                validationId,
                attempt,
                profileName,
                verification: buildProfilePermissionDisableVerification({
                    permissionName,
                    beforeAnalysis,
                    afterAnalysis: analyzePermissionBlockMatch(
                        parseProfileUserPermissionBlocks(readBack),
                        permissionName
                    ),
                    workspaceReadBack: true,
                    xmlStructureValid: true,
                    workspaceIntegrityVerified: false,
                    unrelatedBlocksUnchanged:
                        buildUnrelatedPermissionBlocksFingerprint(
                            readBack,
                            permissionName
                        ) === unrelatedBlocksBefore,
                    salesforcePermissionNameMatches:
                        parseManageKnowledgeImportExportDependencyProblem(
                            confirmedFailure?.sourceFailure?.problem
                        )?.permissionName === permissionName
                })
            });

            return {
                ok: false,
                reason: `Sanitized Profile read-back verification failed for "${profileName}".`,
                disabledPermissions: []
            };
        }

        const afterAnalysis = analyzePermissionBlockMatch(
            parseProfileUserPermissionBlocks(readBack),
            permissionName
        );
        const unrelatedBlocksReadBack = buildUnrelatedPermissionBlocksFingerprint(
            readBack,
            permissionName
        );
        const unrelatedBlocksUnchanged =
            unrelatedBlocksReadBack === unrelatedBlocksBefore;

        if (
            afterAnalysis.matching.length !== 1 ||
            afterAnalysis.enabledTrue.length ||
            afterAnalysis.enabledFalse.length !== 1
        ) {
            emitProfilePermissionDisableVerifiedDiagnostic({
                validationId,
                attempt,
                profileName,
                verification: buildProfilePermissionDisableVerification({
                    permissionName,
                    beforeAnalysis,
                    afterAnalysis,
                    workspaceReadBack: true,
                    xmlStructureValid: true,
                    workspaceIntegrityVerified: true,
                    unrelatedBlocksUnchanged,
                    salesforcePermissionNameMatches:
                        parseManageKnowledgeImportExportDependencyProblem(
                            confirmedFailure?.sourceFailure?.problem
                        )?.permissionName === permissionName
                })
            });

            return {
                ok: false,
                reason: `Permission "${permissionName}" was not disabled correctly in Profile "${profileName}".`,
                disabledPermissions: []
            };
        }

        emitProfilePermissionDisableVerifiedDiagnostic({
            validationId,
            attempt,
            profileName,
            verification: buildProfilePermissionDisableVerification({
                permissionName,
                beforeAnalysis,
                afterAnalysis,
                workspaceReadBack: true,
                xmlStructureValid: true,
                workspaceIntegrityVerified: true,
                unrelatedBlocksUnchanged,
                salesforcePermissionNameMatches:
                    parseManageKnowledgeImportExportDependencyProblem(
                        confirmedFailure?.sourceFailure?.problem
                    )?.permissionName === permissionName
            })
        });

        profilePermissionSanitizationDiagnosticLog.logWorkspaceModification({
            validationId,
            attempt,
            profileName,
            success: true,
            removedPermissionNames: [],
            originalCanonicalSha256,
            finalWorkspaceSha256,
            readBackVerification: 'PASSED',
            workspaceIntegrityStatus: 'VERIFIED'
        });

        disabledPermissions.push({
            profileName,
            permissionName,
            originalEnabled: true,
            finalEnabled: false,
            classification: 'DEPENDENCY_PERMISSION_DISABLED',
            reason:
                'Destination requires unavailable dependent permissions for ManageKnowledgeImportExport.',
            dependencyPermissionNames: [...dependencyPermissionNames],
            sourceFailure: {
                problem:
                    confirmedFailure?.sourceFailure?.problem ||
                    MANAGE_KNOWLEDGE_DEPENDENCY_PROBLEM,
                deploymentId: deploymentId || null
            },
            attempt
        });
    } catch (error) {
        profilePermissionSanitizationDiagnosticLog.logWorkspaceModification({
            validationId,
            attempt,
            profileName,
            success: false,
            removedPermissionNames: [],
            originalCanonicalSha256,
            finalWorkspaceSha256: null,
            readBackVerification: 'FAILED',
            workspaceIntegrityStatus: 'BLOCKED',
            blockReason: error?.message || null
        });
        emitProfilePermissionDisableVerifiedDiagnostic({
            validationId,
            attempt,
            profileName,
            verification: buildProfilePermissionDisableVerification({
                permissionName,
                beforeAnalysis,
                afterAnalysis: null,
                workspaceReadBack: false,
                xmlStructureValid: false,
                workspaceIntegrityVerified: false,
                unrelatedBlocksUnchanged: false,
                salesforcePermissionNameMatches:
                    parseManageKnowledgeImportExportDependencyProblem(
                        confirmedFailure?.sourceFailure?.problem
                    )?.permissionName === permissionName
            })
        });

        return {
            ok: false,
            reason:
                error?.message ||
                `Sanitized Profile workspace update failed for "${profileName}".`,
            disabledPermissions: []
        };
    }

    return {
        ok: true,
        disabledPermissions
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
    MANAGE_KNOWLEDGE_DEPENDENCY_PROBLEM,
    MANAGE_KNOWLEDGE_IMPORT_EXPORT_PERMISSION,
    parseUnknownUserPermissionProblem,
    parseManageKnowledgeImportExportDependencyProblem,
    resolveFailureProfileName,
    isConfirmedUnknownUserPermissionFailure,
    isConfirmedManageKnowledgeDependencyFailure,
    classifyComponentFailureForDiagnosticLog,
    extractComponentFailures,
    extractConfirmedUnknownUserPermissionFailures,
    extractConfirmedManageKnowledgeDependencyFailure,
    parseProfileUserPermissionBlocks,
    analyzePermissionBlockMatch,
    removeSingleUserPermissionBlock,
    disableSingleUserPermissionEnabledFlag,
    validateSanitizedProfileXml,
    buildProfilePermissionRemovalVerification,
    buildProfilePermissionDisableVerification,
    buildSelectedProfileNameSet,
    emptyProfilePermissionSanitization,
    applySanitizationPlan,
    applyDependencyDisablePlan,
    refreshFinalWorkspaceHashes
};
