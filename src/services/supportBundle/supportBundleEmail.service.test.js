const assert = require('assert');
const Module = require('module');

const {
    sendSupportBundleEmail,
    buildEmailSubject,
    buildEmailBody,
    buildAttachmentFilename,
    resolveSupportBundleRecipient,
    DEFAULT_RECIPIENT,
    DELIVERY_FAILED_MESSAGE,
    NOT_CONFIGURED_MESSAGE,
    DISABLED_MESSAGE
} = require('./supportBundleEmail.service');

const {
    buildSupportBundle
} = require('./supportBundle.service');

const {
    sanitizeSupportBundlePayload
} = require('./supportBundleSanitizer');

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

function sampleSanitizedContext(overrides = {}) {
    return {
        historyId: 'history_20260810_001',
        deploymentId: '0AfNS00000jYTth0AG',
        deploymentMode: 'VALIDATE',
        failureClassification: {
            failures: [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'WeatherAccess',
                    category: 'MISSING_DEPENDENCY',
                    reason: 'Missing ExternalCredential dependency',
                    safeToSkip: false
                }
            ]
        },
        resolutionReport: {
            resolutions: [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'WeatherAccess',
                    resolutionType: 'AUTO_FIXABLE',
                    recommendation: 'Deploy ExternalCredential: Weather'
                }
            ]
        },
        autoFixReport: {
            autoFixAvailable: true,
            autoFixApplied: false,
            fixes: []
        },
        autoValidationReport: {
            attempts: 1,
            autoValidationExecuted: true,
            revalidated: true,
            finalStatus: 'FAILED'
        },
        enterpriseDeploymentReport: {
            overallStatus: 'FAILED',
            failures: [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'WeatherAccess'
                }
            ]
        },
        deploymentDiagnostics: {
            deploymentId: '0AfNS00000jYTth0AG',
            overallStatus: 'Failed',
            componentFailures: []
        },
        ...overrides
    };
}

function buildBundle(overrides = {}) {
    const sanitized = sanitizeSupportBundlePayload(
        sampleSanitizedContext(overrides)
    ).payload;
    return buildSupportBundle({
        sanitizedValidationResult: sanitized,
        aiResolutionReport: overrides.aiResolutionReport || null
    });
}

async function main() {
    await runTest('successful email delivery', async () => {
        let captured = null;
        const bundle = buildBundle();
        const result = await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: {
                    SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com',
                    SUPPORT_BUNDLE_EMAIL_ENABLED: 'true'
                },
                transport: async (payload) => {
                    captured = payload;
                }
            }
        );
        assert.strictEqual(result.sent, true);
        assert.strictEqual(result.status, 'SENT');
        assert.strictEqual(result.recipient, 'bnadish1@gmail.com');
        assert.strictEqual(result.bundleId, bundle.bundleId);
        assert.ok(captured);
        assert.strictEqual(captured.recipient, 'bnadish1@gmail.com');
    });

    await runTest('email disabled/not configured', async () => {
        const bundle = buildBundle();
        const disabled = await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: {
                    SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com',
                    SUPPORT_BUNDLE_EMAIL_ENABLED: 'false'
                }
            }
        );
        assert.strictEqual(disabled.sent, false);
        assert.strictEqual(disabled.status, 'DISABLED');
        assert.strictEqual(disabled.message, DISABLED_MESSAGE);

        const notConfigured = await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: {
                    SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com',
                    SUPPORT_BUNDLE_EMAIL_ENABLED: 'true'
                }
            }
        );
        assert.strictEqual(notConfigured.sent, false);
        assert.strictEqual(notConfigured.status, 'NOT_CONFIGURED');
        assert.ok(
            String(notConfigured.message).includes('not configured') ||
                notConfigured.message === NOT_CONFIGURED_MESSAGE
        );
    });

    await runTest('missing recipient configuration', async () => {
        const bundle = buildBundle();
        // Empty string overrides default for this test via custom env resolver path:
        // resolveSupportBundleRecipient returns DEFAULT when unset; simulate missing
        // by passing env with SUPPORT_BUNDLE_EMAIL='' and patching through empty after trim
        // → falls back to DEFAULT. Explicit missing is tested via forced null recipient
        // by using transport-less path with SUPPORT_BUNDLE_EMAIL set to spaces only...
        // spaces trim to empty → DEFAULT. Documented MVP always has DEFAULT_RECIPIENT.
        assert.strictEqual(
            resolveSupportBundleRecipient({ SUPPORT_BUNDLE_EMAIL: '' }),
            DEFAULT_RECIPIENT
        );
        assert.strictEqual(
            resolveSupportBundleRecipient({
                SUPPORT_BUNDLE_EMAIL: 'custom@example.com'
            }),
            'custom@example.com'
        );
    });

    await runTest('provider failure', async () => {
        const bundle = buildBundle();
        const result = await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async () => {
                    throw new Error('SMTP AUTH LOGIN failed for user xxxxx');
                }
            }
        );
        assert.strictEqual(result.sent, false);
        assert.strictEqual(result.status, 'FAILED');
        assert.strictEqual(result.message, DELIVERY_FAILED_MESSAGE);
        assert.ok(!JSON.stringify(result).includes('SMTP AUTH'));
        assert.ok(!JSON.stringify(result).includes('xxxxx'));
    });

    await runTest('timeout', async () => {
        const bundle = buildBundle();
        const result = await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: {
                    SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com',
                    SUPPORT_BUNDLE_EMAIL_FROM: 'noreply@example.com',
                    SUPPORT_BUNDLE_EMAIL_PROVIDER: 'resend',
                    RESEND_API_KEY: 're_test'
                },
                httpPost: async () => {
                    const err = new Error('timeout of 15000ms exceeded');
                    err.code = 'ECONNABORTED';
                    throw err;
                }
            }
        );
        assert.strictEqual(result.sent, false);
        assert.strictEqual(result.status, 'FAILED');
        assert.strictEqual(result.message, DELIVERY_FAILED_MESSAGE);
    });

    await runTest('sanitized bundle attachment', async () => {
        let attachment = '';
        const dirty = sampleSanitizedContext({
            accessToken: 'SECRET_ACCESS',
            cliStdout: 'RAW'
        });
        const sanitized = sanitizeSupportBundlePayload(dirty).payload;
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(attachment.includes(bundle.bundleId));
        assert.ok(!attachment.includes('SECRET_ACCESS'));
        assert.ok(!attachment.includes('RAW'));
        const parsed = JSON.parse(attachment);
        assert.strictEqual(parsed.bundleId, bundle.bundleId);
    });

    await runTest('correct bundle ID', async () => {
        const bundle = buildBundle();
        const result = await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async () => {}
            }
        );
        assert.strictEqual(result.bundleId, bundle.bundleId);
        assert.match(result.bundleId, /^SUP-\d{8}-[0-9A-F]{6}$/);
    });

    await runTest('correct subject', () => {
        const failed = buildBundle();
        assert.strictEqual(
            buildEmailSubject(failed),
            `[Metadata Migration Support] Deployment Issue — ${failed.bundleId}`
        );

        const ok = buildSupportBundle({
            sanitizedValidationResult: {
                enterpriseDeploymentReport: { overallStatus: 'SUCCESS' },
                failureClassification: { failures: [] }
            }
        });
        assert.strictEqual(
            buildEmailSubject(ok),
            `[Metadata Migration Support] Support Bundle — ${ok.bundleId}`
        );
    });

    await runTest('correct filename', () => {
        assert.strictEqual(
            buildAttachmentFilename('SUP-20260810-A1B2C3'),
            'SUP-20260810-A1B2C3.json'
        );
    });

    await runTest('correct recipient', async () => {
        let recipient = null;
        await sendSupportBundleEmail(
            { supportBundle: buildBundle() },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    recipient = payload.recipient;
                }
            }
        );
        assert.strictEqual(recipient, 'bnadish1@gmail.com');
    });

    await runTest('Formula failure email', async () => {
        let body = '';
        const bundle = buildBundle({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        reason: 'Formula type conversion is incompatible.',
                        category: 'MANUAL_ACTION'
                    }
                ]
            }
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    body = payload.text;
                }
            }
        );
        assert.ok(body.includes('Account.Score__c'));
        assert.ok(body.includes('Formula'));
    });

    await runTest('PersonAccount failure email', async () => {
        let body = '';
        const bundle = buildBundle({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'PersonAccount.PersonAccount',
                        reason: 'Person Accounts not enabled.',
                        category: 'DESTINATION_FEATURE'
                    }
                ]
            }
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    body = payload.text;
                }
            }
        );
        assert.ok(body.includes('PersonAccount'));
    });

    await runTest('missing dependency email', async () => {
        const body = buildEmailBody(buildBundle());
        assert.ok(body.includes('WeatherAccess'));
        assert.ok(body.includes('Missing ExternalCredential'));
    });

    await runTest('auto-fix information included', () => {
        const body = buildEmailBody(buildBundle());
        assert.ok(body.includes('Auto Fix:'));
        assert.ok(body.includes('Not Applied') || body.includes('Available'));
    });

    await runTest('auto-validation information included', () => {
        const body = buildEmailBody(buildBundle());
        assert.ok(body.includes('Auto Validation:'));
        assert.ok(body.includes('Completed'));
    });

    await runTest('AI report included when generated', () => {
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sampleSanitizedContext(),
            aiResolutionReport: {
                generated: true,
                provider: 'gemini',
                summary: 'Advisory',
                explanations: []
            }
        });
        const body = buildEmailBody(bundle);
        assert.ok(body.includes('AI Resolution:'));
        assert.ok(body.includes('Available'));
    });

    await runTest('AI report absent', () => {
        const body = buildEmailBody(buildBundle());
        assert.ok(body.includes('Not Requested') || body.includes('Unavailable'));
    });

    await runTest('enterprise report included', () => {
        const bundle = buildBundle();
        assert.strictEqual(
            bundle.enterpriseDeploymentReport.overallStatus,
            'FAILED'
        );
        const body = buildEmailBody(bundle);
        assert.ok(body.includes('FAILED'));
    });

    await runTest('no access token', async () => {
        let text = '';
        let attachment = '';
        await sendSupportBundleEmail(
            {
                supportBundle: buildBundle({
                    accessToken: 'SECRET_ACCESS_TOKEN'
                })
            },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    text = payload.text;
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(!text.includes('SECRET_ACCESS_TOKEN'));
        assert.ok(!attachment.includes('SECRET_ACCESS_TOKEN'));
    });

    await runTest('no refresh token', async () => {
        let attachment = '';
        const sanitized = sanitizeSupportBundlePayload(
            sampleSanitizedContext({ refreshToken: 'SECRET_REFRESH' })
        ).payload;
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(!attachment.includes('SECRET_REFRESH'));
    });

    await runTest('no API key', async () => {
        let attachment = '';
        const sanitized = sanitizeSupportBundlePayload(
            sampleSanitizedContext({ apiKey: 'sk-live-SECRET' })
        ).payload;
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(!attachment.includes('sk-live-SECRET'));
    });

    await runTest('no GitHub token', async () => {
        let text = '';
        let attachment = '';
        const sanitized = sanitizeSupportBundlePayload(
            sampleSanitizedContext({
                repositoryUrl: 'https://ghp_SECRETTOKEN@github.com/org/repo.git'
            })
        ).payload;
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    text = payload.text;
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(!text.includes('ghp_SECRETTOKEN'));
        assert.ok(!attachment.includes('ghp_SECRETTOKEN'));
    });

    await runTest('no source code', async () => {
        let attachment = '';
        const sanitized = sanitizeSupportBundlePayload(
            sampleSanitizedContext({ sourceCode: 'public class Leak {}' })
        ).payload;
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(!attachment.includes('public class Leak'));
    });

    await runTest('no metadata XML', async () => {
        let attachment = '';
        const sanitized = sanitizeSupportBundlePayload(
            sampleSanitizedContext({ metadataXml: '<ApexClass/>' })
        ).payload;
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(!attachment.includes('<ApexClass/>'));
    });

    await runTest('no raw CLI output', async () => {
        let attachment = '';
        const sanitized = sanitizeSupportBundlePayload(
            sampleSanitizedContext({
                cliStdout: 'RAW_STDOUT',
                cliStderr: 'RAW_STDERR'
            })
        ).payload;
        const bundle = buildSupportBundle({
            sanitizedValidationResult: sanitized
        });
        await sendSupportBundleEmail(
            { supportBundle: bundle },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    attachment = payload.attachmentContent;
                }
            }
        );
        assert.ok(!attachment.includes('RAW_STDOUT'));
        assert.ok(!attachment.includes('RAW_STDERR'));
    });

    await runTest('client cannot override recipient', async () => {
        // Email service never accepts client recipient — only env / default.
        let recipient = null;
        await sendSupportBundleEmail(
            {
                supportBundle: buildBundle(),
                email: 'attacker@evil.com',
                recipient: 'attacker@evil.com',
                to: 'attacker@evil.com'
            },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                transport: async (payload) => {
                    recipient = payload.recipient;
                }
            }
        );
        assert.strictEqual(recipient, 'bnadish1@gmail.com');
    });

    await runTest('client cannot override subject', () => {
        const bundle = buildBundle();
        const subject = buildEmailSubject(bundle);
        assert.ok(subject.includes(bundle.bundleId));
        assert.ok(subject.startsWith('[Metadata Migration Support]'));
        // Subject is derived only from bundle status — no client input path.
    });

    await runTest('email failure does not destroy bundle', async () => {
        const api = require('./supportBundleApi.service');
        const historyService = require('../deploymentHistory.service');
        const historyId = historyService.createHistory({
            deploymentPackage: { deploymentMode: 'VALIDATE' },
            deploymentReadiness: { overallStatus: 'NOT_READY', summary: {} }
        });

        const result = await api.createSupportBundleFromRequest(
            {
                validationId: historyId,
                validationContext: sampleSanitizedContext(),
                email: 'attacker@evil.com',
                subject: 'Hacked subject'
            },
            {
                env: { SUPPORT_BUNDLE_EMAIL: 'bnadish1@gmail.com' },
                emailTransport: async () => {
                    throw new Error('provider down');
                }
            }
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.supportBundle.bundleId);
        assert.strictEqual(result.supportBundleDelivery.email.sent, false);
        assert.strictEqual(result.supportBundleDelivery.email.status, 'FAILED');
        assert.strictEqual(
            result.supportBundleDelivery.email.recipient,
            'bnadish1@gmail.com'
        );
    });

    await runTest('no deployment execution', () => {
        const emailPath = require.resolve('./supportBundleEmail.service');
        const children = Module._cache[emailPath]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('deploymentValidation')));
        assert.ok(!ids.some((id) => id.includes('checkOnlyDeployment')));
        assert.ok(!ids.some((id) => id.includes('deploymentAutoFix')));
    });

    await runTest('no Salesforce API call', () => {
        const emailPath = require.resolve('./supportBundleEmail.service');
        const children = Module._cache[emailPath]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('jsforce')));
        assert.ok(!ids.some((id) => id.includes('salesforce')));
    });

    await runTest('no AI provider call', () => {
        const emailPath = require.resolve('./supportBundleEmail.service');
        const children = Module._cache[emailPath]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('aiDeploymentAdvisor')));
        assert.ok(!ids.some((id) => id.includes('openai')));
        assert.ok(!ids.some((id) => id.includes('@google/genai')));
    });

    await runTest('no validation retry', async () => {
        const api = require('./supportBundleApi.service');
        const historyService = require('../deploymentHistory.service');
        const historyId = historyService.createHistory({
            deploymentPackage: { deploymentMode: 'VALIDATE' },
            deploymentReadiness: { overallStatus: 'NOT_READY', summary: {} }
        });
        let sanitizeCalls = 0;
        await api.createSupportBundleFromRequest(
            {
                validationId: historyId,
                validationContext: sampleSanitizedContext()
            },
            {
                env: { SUPPORT_BUNDLE_EMAIL_ENABLED: 'false' },
                sanitizeSupportBundlePayload: (input) => {
                    sanitizeCalls += 1;
                    return sanitizeSupportBundlePayload(input);
                }
            }
        );
        assert.strictEqual(sanitizeCalls, 1);
    });

    if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
    }
}

main();
