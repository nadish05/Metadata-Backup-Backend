/**
 * Support Bundle Email Delivery (Phase 17.8.4)
 *
 * Sends a sanitized Support Bundle to the configured support mailbox.
 * Recipient is backend-controlled (never from the client).
 *
 * Providers (via existing axios — no new dependency required):
 * - Resend  (RESEND_API_KEY)
 * - SendGrid (SENDGRID_API_KEY)
 *
 * Transport is injectable for unit tests.
 */

'use strict';

const axios = require('axios');

const DEFAULT_RECIPIENT = 'bnadish1@gmail.com';
const DELIVERY_FAILED_MESSAGE =
    'Support bundle was generated, but email delivery failed.';
const NOT_CONFIGURED_MESSAGE =
    'Support bundle email is not configured (missing email provider credentials).';
const DISABLED_MESSAGE = 'Support bundle email delivery is disabled.';
const MISSING_RECIPIENT_MESSAGE =
    'Support bundle email recipient is not configured.';

function parseEnvBool(value, defaultValue) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return defaultValue;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * Backend-controlled recipient. Client overrides are ignored by callers.
 */
function resolveSupportBundleRecipient(env = process.env) {
    const configured = String(env.SUPPORT_BUNDLE_EMAIL || '').trim();
    if (configured) {
        return configured;
    }
    // MVP default support destination (not a secret).
    return DEFAULT_RECIPIENT;
}

function isEmailDeliveryEnabled(env = process.env) {
    return parseEnvBool(env.SUPPORT_BUNDLE_EMAIL_ENABLED, true);
}

function resolveFromAddress(env = process.env) {
    const from = String(
        env.SUPPORT_BUNDLE_EMAIL_FROM ||
            env.RESEND_FROM ||
            env.SENDGRID_FROM ||
            ''
    ).trim();
    return from || null;
}

function detectProvider(env = process.env) {
    const explicit = String(env.SUPPORT_BUNDLE_EMAIL_PROVIDER || '')
        .trim()
        .toLowerCase();
    if (explicit === 'resend' || explicit === 'sendgrid' || explicit === 'mock') {
        return explicit;
    }
    if (String(env.RESEND_API_KEY || '').trim()) {
        return 'resend';
    }
    if (String(env.SENDGRID_API_KEY || '').trim()) {
        return 'sendgrid';
    }
    return null;
}

function deriveOverallStatus(supportBundle) {
    const status =
        supportBundle?.status?.overallStatus ||
        supportBundle?.status?.enterpriseOverallStatus ||
        supportBundle?.enterpriseDeploymentReport?.overallStatus ||
        null;
    return status == null ? null : String(status).toUpperCase();
}

function buildEmailSubject(supportBundle) {
    const bundleId = supportBundle?.bundleId || 'UNKNOWN';
    const overall = deriveOverallStatus(supportBundle);

    if (overall === 'FAILED' || overall === 'NOT_READY' || overall === 'ERROR') {
        return `[Metadata Migration Support] Deployment Issue — ${bundleId}`;
    }

    return `[Metadata Migration Support] Support Bundle — ${bundleId}`;
}

function buildAttachmentFilename(bundleId) {
    const id = bundleId || 'UNKNOWN';
    return `${id}.json`;
}

function firstFailure(supportBundle) {
    const failures = asArray(supportBundle?.failureClassification?.failures);
    if (failures.length > 0) {
        return failures[0];
    }
    const enterprise = asArray(supportBundle?.enterpriseDeploymentReport?.failures);
    if (enterprise.length > 0) {
        return enterprise[0];
    }
    const components = asArray(
        supportBundle?.deploymentDiagnostics?.componentFailures
    );
    return components[0] || null;
}

function formatMetadataLine(failure) {
    if (!failure) {
        return 'None';
    }
    const type = failure.metadataType || failure.type || 'Unknown';
    const name = failure.metadataName || failure.name || 'Unknown';
    return `${type} — ${name}`;
}

function formatAiLine(supportBundle) {
    const ai = supportBundle?.aiResolution;
    if (!ai || ai.present !== true) {
        if (ai && ai.present === false) {
            return 'Not Requested';
        }
        return 'Unavailable';
    }
    return 'Available';
}

function formatAutoFixLine(supportBundle) {
    const report = supportBundle?.autoFixReport;
    if (!isPlainObject(report) || Object.keys(report).length === 0) {
        return 'Not Available';
    }
    if (report.autoFixApplied === true) {
        return 'Applied';
    }
    if (report.autoFixAvailable === true) {
        return 'Available (Not Applied)';
    }
    return 'Not Applied';
}

function formatAutoValidationLine(supportBundle) {
    const report = supportBundle?.autoValidationReport;
    if (!isPlainObject(report) || Object.keys(report).length === 0) {
        return 'Not Available';
    }
    if (report.revalidated === true || report.autoValidationExecuted === true) {
        return 'Completed';
    }
    if (report.finalStatus) {
        return String(report.finalStatus);
    }
    return 'Not Executed';
}

function buildEmailBody(supportBundle) {
    const failure = firstFailure(supportBundle);
    const resolution = asArray(supportBundle?.resolutionReport?.resolutions)[0];

    const lines = [
        'Support Bundle Created',
        '',
        'Bundle ID:',
        supportBundle?.bundleId || 'N/A',
        '',
        'Overall Status:',
        deriveOverallStatus(supportBundle) || 'N/A',
        '',
        'Metadata:',
        formatMetadataLine(failure),
        '',
        'Issue:',
        failure?.reason ||
            failure?.message ||
            failure?.category ||
            'No failure details',
        '',
        'Resolution:',
        resolution?.summary ||
            resolution?.recommendation ||
            resolution?.resolutionType ||
            'N/A',
        '',
        'Auto Fix:',
        formatAutoFixLine(supportBundle),
        '',
        'Auto Validation:',
        formatAutoValidationLine(supportBundle),
        '',
        'AI Resolution:',
        formatAiLine(supportBundle),
        '',
        'Deployment ID:',
        supportBundle?.correlation?.deploymentId ||
            supportBundle?.salesforceOutcome?.deploymentId ||
            'N/A',
        '',
        'Validation ID:',
        supportBundle?.correlation?.historyId ||
            supportBundle?.correlation?.validationCorrelationId ||
            'N/A',
        '',
        'The complete sanitized Support Bundle is attached.',
        '',
        supportBundle?.disclaimer ||
            'Support Bundle is diagnostic only. It does not change deployment decisions.'
    ];

    return lines.join('\n');
}

function serializeBundleAttachment(supportBundle) {
    return JSON.stringify(supportBundle, null, 2);
}

function deliveryResult({
    requested,
    sent,
    status,
    recipient,
    bundleId,
    message = null,
    subject = null,
    filename = null
}) {
    const result = {
        requested: requested === true,
        sent: sent === true,
        status,
        recipient: recipient || null,
        bundleId: bundleId || null
    };
    if (message) {
        result.message = message;
    }
    if (subject) {
        result.subject = subject;
    }
    if (filename) {
        result.filename = filename;
    }
    return result;
}

async function sendViaResend({
    apiKey,
    from,
    recipient,
    subject,
    text,
    filename,
    attachmentContent,
    httpPost
}) {
    const post = httpPost || axios.post.bind(axios);
    await post(
        'https://api.resend.com/emails',
        {
            from,
            to: [recipient],
            subject,
            text,
            attachments: [
                {
                    filename,
                    content: Buffer.from(attachmentContent, 'utf8').toString(
                        'base64'
                    )
                }
            ]
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );
}

async function sendViaSendGrid({
    apiKey,
    from,
    recipient,
    subject,
    text,
    filename,
    attachmentContent,
    httpPost
}) {
    const post = httpPost || axios.post.bind(axios);
    await post(
        'https://api.sendgrid.com/v3/mail/send',
        {
            personalizations: [{ to: [{ email: recipient }] }],
            from: { email: from },
            subject,
            content: [{ type: 'text/plain', value: text }],
            attachments: [
                {
                    content: Buffer.from(attachmentContent, 'utf8').toString(
                        'base64'
                    ),
                    filename,
                    type: 'application/json',
                    disposition: 'attachment'
                }
            ]
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );
}

/**
 * Send Support Bundle email.
 *
 * @param {{ supportBundle: object }} input
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function sendSupportBundleEmail({ supportBundle } = {}, deps = {}) {
    const env = deps.env || process.env;
    const bundleId = supportBundle?.bundleId || null;
    const recipient = resolveSupportBundleRecipient(env);
    const subject = buildEmailSubject(supportBundle);
    const filename = buildAttachmentFilename(bundleId);
    const text = buildEmailBody(supportBundle);
    const attachmentContent = serializeBundleAttachment(supportBundle);

    if (!isEmailDeliveryEnabled(env)) {
        return deliveryResult({
            requested: true,
            sent: false,
            status: 'DISABLED',
            recipient,
            bundleId,
            message: DISABLED_MESSAGE,
            subject,
            filename
        });
    }

    if (!recipient) {
        return deliveryResult({
            requested: true,
            sent: false,
            status: 'NOT_CONFIGURED',
            recipient: null,
            bundleId,
            message: MISSING_RECIPIENT_MESSAGE,
            subject,
            filename
        });
    }

    // Injectable transport for unit tests (never used as client override).
    if (typeof deps.transport === 'function') {
        try {
            await deps.transport({
                recipient,
                subject,
                text,
                filename,
                attachmentContent,
                supportBundle,
                bundleId
            });
            return deliveryResult({
                requested: true,
                sent: true,
                status: 'SENT',
                recipient,
                bundleId,
                subject,
                filename
            });
        } catch (error) {
            console.error('SUPPORT BUNDLE EMAIL ERROR');
            console.error('email transport failed');
            return deliveryResult({
                requested: true,
                sent: false,
                status: 'FAILED',
                recipient,
                bundleId,
                message: DELIVERY_FAILED_MESSAGE,
                subject,
                filename
            });
        }
    }

    const provider = detectProvider(env);
    const from = resolveFromAddress(env);

    if (!provider || provider === 'mock') {
        return deliveryResult({
            requested: true,
            sent: false,
            status: 'NOT_CONFIGURED',
            recipient,
            bundleId,
            message: NOT_CONFIGURED_MESSAGE,
            subject,
            filename
        });
    }

    if (!from) {
        return deliveryResult({
            requested: true,
            sent: false,
            status: 'NOT_CONFIGURED',
            recipient,
            bundleId,
            message:
                'Support bundle email sender (SUPPORT_BUNDLE_EMAIL_FROM) is not configured.',
            subject,
            filename
        });
    }

    try {
        if (provider === 'resend') {
            const apiKey = String(env.RESEND_API_KEY || '').trim();
            if (!apiKey) {
                return deliveryResult({
                    requested: true,
                    sent: false,
                    status: 'NOT_CONFIGURED',
                    recipient,
                    bundleId,
                    message: NOT_CONFIGURED_MESSAGE,
                    subject,
                    filename
                });
            }
            await sendViaResend({
                apiKey,
                from,
                recipient,
                subject,
                text,
                filename,
                attachmentContent,
                httpPost: deps.httpPost
            });
        } else if (provider === 'sendgrid') {
            const apiKey = String(env.SENDGRID_API_KEY || '').trim();
            if (!apiKey) {
                return deliveryResult({
                    requested: true,
                    sent: false,
                    status: 'NOT_CONFIGURED',
                    recipient,
                    bundleId,
                    message: NOT_CONFIGURED_MESSAGE,
                    subject,
                    filename
                });
            }
            await sendViaSendGrid({
                apiKey,
                from,
                recipient,
                subject,
                text,
                filename,
                attachmentContent,
                httpPost: deps.httpPost
            });
        } else {
            return deliveryResult({
                requested: true,
                sent: false,
                status: 'NOT_CONFIGURED',
                recipient,
                bundleId,
                message: NOT_CONFIGURED_MESSAGE,
                subject,
                filename
            });
        }

        return deliveryResult({
            requested: true,
            sent: true,
            status: 'SENT',
            recipient,
            bundleId,
            subject,
            filename
        });
    } catch (error) {
        const isTimeout =
            error?.code === 'ECONNABORTED' ||
            error?.code === 'ETIMEDOUT' ||
            /timeout/i.test(String(error?.message || ''));

        console.error('SUPPORT BUNDLE EMAIL ERROR');
        console.error(isTimeout ? 'email provider timeout' : 'email provider failed');

        return deliveryResult({
            requested: true,
            sent: false,
            status: 'FAILED',
            recipient,
            bundleId,
            message: DELIVERY_FAILED_MESSAGE,
            subject,
            filename
        });
    }
}

module.exports = {
    sendSupportBundleEmail,
    buildEmailSubject,
    buildEmailBody,
    buildAttachmentFilename,
    resolveSupportBundleRecipient,
    DEFAULT_RECIPIENT,
    DELIVERY_FAILED_MESSAGE,
    NOT_CONFIGURED_MESSAGE,
    DISABLED_MESSAGE
};
