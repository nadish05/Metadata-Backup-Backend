'use strict';

const SECRET_KEY_PATTERN =
    /^(refreshToken|accessToken|authorization|password|secret|token|clientSecret|client_secret|sessionId|session_id|cookie)$/i;

function isSecretKey(key) {
    return SECRET_KEY_PATTERN.test(String(key || ''));
}

function sanitizeValue(value) {
    if (value === null || value === undefined) {
        return value;
    }

    if (Buffer.isBuffer(value)) {
        return undefined;
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => sanitizeValue(entry))
            .filter((entry) => entry !== undefined);
    }

    if (typeof value === 'object') {
        const out = {};

        for (const [key, nested] of Object.entries(value)) {
            if (isSecretKey(key)) {
                continue;
            }

            const sanitized = sanitizeValue(nested);

            if (sanitized !== undefined) {
                out[key] = sanitized;
            }
        }

        return out;
    }

    return value;
}

function sanitizeHistoryRecord(record) {
    if (!record || typeof record !== 'object') {
        return record;
    }

    return sanitizeValue(record);
}

function historyRecordContainsSecrets(record) {
    const json = JSON.stringify(record || {});

    return (
        /refreshToken/i.test(json) ||
        /"accessToken"/i.test(json) ||
        /"authorization"/i.test(json)
    );
}

module.exports = {
    isSecretKey,
    sanitizeValue,
    sanitizeHistoryRecord,
    historyRecordContainsSecrets
};
