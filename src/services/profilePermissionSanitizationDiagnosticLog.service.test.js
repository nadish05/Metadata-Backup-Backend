'use strict';

const assert = require('assert');

const sanitizationService = require('./profileUserPermissionSanitization.service');
const diagnosticLog = require('./profilePermissionSanitizationDiagnosticLog.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function parseLoggedRecords(lines) {
    return lines.map((line) => {
        const jsonPart = line.replace(
            diagnosticLog.LOG_PREFIX,
            ''
        ).trim();
        return JSON.parse(jsonPart);
    });
}

async function main() {
    await runTest('debug logging is enabled when environment flag is true', async () => {
        diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(true);
        const lines = [];
        diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
            lines.push(line)
        );

        try {
            diagnosticLog.logValidationStarted({
                validationId: 'val-debug-on',
                executionPath: 'PROFILE_ONLY_MINIMAL',
                selectedProfileNames: ['Admin'],
                maxCheckOnlyAttempts: 5
            });

            assert.strictEqual(lines.length, 1);
            assert.match(lines[0], /\[PROFILE_PERMISSION_SANITIZATION\]/);
            const record = parseLoggedRecords(lines)[0];
            assert.strictEqual(record.event, 'VALIDATION_STARTED');
            assert.strictEqual(record.validationId, 'val-debug-on');
        } finally {
            diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
            diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        }
    });

    await runTest('detailed logs are suppressed when debug flag is false', async () => {
        diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(false);
        const lines = [];
        diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
            lines.push(line)
        );

        try {
            diagnosticLog.logCheckOnlyAttempt({
                validationId: 'val-debug-off',
                attempt: 1,
                maxAttempts: 5,
                success: false,
                componentFailureCount: 1
            });

            assert.strictEqual(lines.length, 0);
        } finally {
            diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
            diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        }
    });

    await runTest('unknown permission failure is logged with CONFIRMED classification', async () => {
        diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(true);
        const lines = [];
        diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
            lines.push(line)
        );
        const selected = new Set(['Admin']);
        const failure = {
            metadataType: 'Profile',
            metadataName: 'Admin',
            problem: 'Unknown user permission: CreateWorkBadgeDefinition'
        };

        try {
            diagnosticLog.logFailureClassification({
                validationId: 'val-unknown-perm',
                attempt: 1,
                failures: [
                    {
                        metadataType: failure.metadataType,
                        metadataName: failure.metadataName,
                        problem: failure.problem,
                        classification:
                            sanitizationService.classifyComponentFailureForDiagnosticLog(
                                failure,
                                selected
                            )
                    }
                ]
            });

            const record = parseLoggedRecords(lines)[0];
            assert.strictEqual(record.event, 'FAILURE_CLASSIFICATION');
            assert.strictEqual(
                record.failures[0].classification,
                'CONFIRMED_UNKNOWN_USER_PERMISSION'
            );
            assert.strictEqual(
                record.failures[0].problem,
                'Unknown user permission: CreateWorkBadgeDefinition'
            );
        } finally {
            diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
            diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        }
    });

    await runTest(
        'unrecognized dependency failure is logged as UNRECOGNIZED_FAILURE',
        async () => {
            diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(
                true
            );
            const lines = [];
            diagnosticLog.setProfilePermissionSanitizationLogSinkForTests(
                (line) => lines.push(line)
            );
            const selected = new Set(['Admin']);
            const failure = {
                metadataType: 'Profile',
                metadataName: 'Admin',
                problem:
                    'Permission ManageKnowledgeImportExport depends on permission(s): ViewArchivedArticles, ViewDraftArticles'
            };

            try {
                diagnosticLog.logFailureClassification({
                    validationId: 'val-dependency-failure',
                    attempt: 2,
                    failures: [
                        {
                            metadataType: failure.metadataType,
                            metadataName: failure.metadataName,
                            problem: failure.problem,
                            classification:
                                sanitizationService.classifyComponentFailureForDiagnosticLog(
                                    failure,
                                    selected
                                )
                        }
                    ]
                });

                const record = parseLoggedRecords(lines)[0];
                assert.strictEqual(
                    record.failures[0].classification,
                    'UNRECOGNIZED_FAILURE'
                );
            } finally {
                diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
                diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
            }
        }
    );

    await runTest('sanitization success workspace modification is logged', async () => {
        diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(true);
        const lines = [];
        diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
            lines.push(line)
        );

        try {
            diagnosticLog.logWorkspaceModification({
                validationId: 'val-success',
                attempt: 1,
                profileName: 'Admin',
                success: true,
                removedPermissionNames: ['CreateWorkBadgeDefinition'],
                originalCanonicalSha256: 'abc123',
                finalWorkspaceSha256: 'def456',
                readBackVerification: 'PASSED',
                workspaceIntegrityStatus: 'VERIFIED'
            });

            const record = parseLoggedRecords(lines)[0];
            assert.strictEqual(record.event, 'WORKSPACE_MODIFICATION');
            assert.strictEqual(record.success, true);
            assert.strictEqual(record.readBackVerification, 'PASSED');
        } finally {
            diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
            diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        }
    });

    await runTest('hash verification failure is logged', async () => {
        diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(true);
        const lines = [];
        diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
            lines.push(line)
        );

        try {
            diagnosticLog.logWorkspaceModification({
                validationId: 'val-hash-fail',
                attempt: 1,
                profileName: 'Admin',
                success: false,
                removedPermissionNames: ['PermA'],
                originalCanonicalSha256: 'abc123',
                finalWorkspaceSha256: 'mismatch',
                readBackVerification: 'HASH_MISMATCH',
                workspaceIntegrityStatus: 'BLOCKED',
                blockReason:
                    'Sanitized Profile read-back verification failed for "Admin".'
            });

            const record = parseLoggedRecords(lines)[0];
            assert.strictEqual(record.readBackVerification, 'HASH_MISMATCH');
            assert.strictEqual(record.success, false);
        } finally {
            diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
            diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        }
    });

    await runTest('final validation failure is logged', async () => {
        diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(true);
        const lines = [];
        diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
            lines.push(line)
        );

        try {
            diagnosticLog.logFinalResult({
                validationId: 'val-final-blocked',
                sanitizationStatus: 'BLOCKED',
                sanitizationOverallStatus: 'BLOCKED',
                removedCount: 1,
                checkOnlyAttempts: 2,
                finalCheckOnlySuccess: false,
                canDeploy: false,
                boundArtifactCreated: false,
                blockReason:
                    'Check-only failure is not a confirmed unknown user permission message.'
            });

            const record = parseLoggedRecords(lines)[0];
            assert.strictEqual(record.event, 'FINAL_RESULT');
            assert.strictEqual(record.canDeploy, false);
            assert.strictEqual(record.boundArtifactCreated, false);
        } finally {
            diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
            diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
        }
    });

    await runTest('logs omit credentials and Profile XML payloads', async () => {
        const sanitized = diagnosticLog.sanitizeLogPayload({
            validationId: 'val-redact',
            refreshToken: 'secret-refresh',
            access_token: 'secret-access',
            profileXml: '<?xml version="1.0"?><Profile><userPermissions/></Profile>',
            problem: 'Unknown user permission: PermA'
        });

        assert.strictEqual(sanitized.refreshToken, '[redacted]');
        assert.strictEqual(sanitized.access_token, '[redacted]');
        assert.strictEqual(sanitized.profileXml, '[Profile XML omitted]');
        assert.strictEqual(sanitized.problem, 'Unknown user permission: PermA');
    });

    await runTest(
        'sanitization parser behavior unchanged for dependency failure classification',
        async () => {
            const selected = new Set(['Admin']);
            const extractResult =
                sanitizationService.extractConfirmedUnknownUserPermissionFailures(
                    {
                        deploymentDiagnostics: {
                            componentFailures: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin',
                                    problem:
                                        'Permission ManageKnowledgeImportExport depends on permission(s): ViewArchivedArticles, ViewDraftArticles'
                                }
                            ]
                        }
                    },
                    selected
                );

            assert.strictEqual(extractResult.ok, false);
            assert.strictEqual(
                sanitizationService.classifyComponentFailureForDiagnosticLog(
                    {
                        metadataType: 'Profile',
                        metadataName: 'Admin',
                        problem:
                            'Permission ManageKnowledgeImportExport depends on permission(s): ViewArchivedArticles, ViewDraftArticles'
                    },
                    selected
                ),
                'UNRECOGNIZED_FAILURE'
            );
        }
    );

    await runTest(
        'PROFILE_PERMISSION_REMOVAL_VERIFIED event includes PASSED payload fields',
        async () => {
            diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(
                true
            );
            const lines = [];
            diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
                lines.push(line)
            );

            try {
                diagnosticLog.logProfilePermissionRemovalVerified({
                    validationId: 'validation_xxx',
                    profileName: 'Sales Manager',
                    permissionName: 'CreateWorkBadgeDefinition',
                    originalBlockFound: true,
                    originalEnabled: true,
                    matchingBlocksBefore: 1,
                    matchingBlocksAfter: 0,
                    removedBlockCount: 1,
                    workspaceReadBack: true,
                    xmlStructureValid: true,
                    workspaceIntegrityVerified: true,
                    verificationStatus: 'PASSED'
                });

                const record = JSON.parse(
                    lines[0].replace(diagnosticLog.LOG_PREFIX, '').trim()
                );
                assert.strictEqual(
                    record.event,
                    'PROFILE_PERMISSION_REMOVAL_VERIFIED'
                );
                assert.strictEqual(record.verificationStatus, 'PASSED');
                assert.strictEqual(record.matchingBlocksAfter, 0);
            } finally {
                diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
                diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
            }
        }
    );

    await runTest(
        'PROFILE_PERMISSION_REMOVAL_VERIFIED FAILED event includes safe failure reason',
        async () => {
            diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(
                true
            );
            const lines = [];
            diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
                lines.push(line)
            );

            try {
                diagnosticLog.logProfilePermissionRemovalVerified({
                    validationId: 'validation_blocked',
                    profileName: 'Sales Manager',
                    permissionName: 'CreateWorkBadgeDefinition',
                    originalBlockFound: true,
                    originalEnabled: true,
                    matchingBlocksBefore: 1,
                    matchingBlocksAfter: 1,
                    removedBlockCount: 1,
                    workspaceReadBack: true,
                    xmlStructureValid: true,
                    workspaceIntegrityVerified: true,
                    verificationStatus: 'FAILED',
                    failureReason:
                        'Expected matchingBlocksAfter=0 but found 1.'
                });

                const record = JSON.parse(
                    lines[0].replace(diagnosticLog.LOG_PREFIX, '').trim()
                );
                assert.strictEqual(record.verificationStatus, 'FAILED');
                assert.match(record.failureReason, /matchingBlocksAfter=0/);
            } finally {
                diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
                diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
            }
        }
    );

    await runTest(
        'PROFILE_PERMISSION_REMOVAL_VERIFIED is not emitted when debug is disabled',
        async () => {
            diagnosticLog.setProfilePermissionSanitizationDebugEnabledForTests(
                false
            );
            const lines = [];
            diagnosticLog.setProfilePermissionSanitizationLogSinkForTests((line) =>
                lines.push(line)
            );

            try {
                diagnosticLog.logProfilePermissionRemovalVerified({
                    validationId: 'validation_off',
                    permissionName: 'CreateWorkBadgeDefinition',
                    verificationStatus: 'PASSED'
                });

                assert.strictEqual(lines.length, 0);
            } finally {
                diagnosticLog.resetProfilePermissionSanitizationLogSinkForTests();
                diagnosticLog.resetProfilePermissionSanitizationDebugForTests();
            }
        }
    );
}

main();

main();
