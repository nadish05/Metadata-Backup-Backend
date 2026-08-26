'use strict';

const CONTROL_PLANE_ERROR_CODE = Object.freeze({
    CONTROL_PLANE_AUTH_UNAVAILABLE: 'CONTROL_PLANE_AUTH_UNAVAILABLE',
    CONTROL_PLANE_UNAVAILABLE: 'CONTROL_PLANE_UNAVAILABLE',
    CONTROL_PLANE_TIMEOUT: 'CONTROL_PLANE_TIMEOUT',
    CONTROL_PLANE_PERMISSION_DENIED: 'CONTROL_PLANE_PERMISSION_DENIED',
    CONTROL_PLANE_NOT_FOUND: 'CONTROL_PLANE_NOT_FOUND',
    CONTROL_PLANE_CONFLICT: 'CONTROL_PLANE_CONFLICT',
    CONTROL_PLANE_SCHEMA_MISMATCH: 'CONTROL_PLANE_SCHEMA_MISMATCH',
    CONTROL_PLANE_INVALID_RESPONSE: 'CONTROL_PLANE_INVALID_RESPONSE'
});

const SECRET_PATTERN =
    /(?:refreshToken|accessToken|authorization|clientSecret|client_secret|password|sessionId|apiKey)(["\s:=]+)[^\s,"']+/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-]+/gi;

function sanitizeControlPlaneText(value) {
    if (value === null || value === undefined) {
        return value;
    }

    return String(value)
        .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
        .replace(SECRET_PATTERN, () => ' [REDACTED]');
}

class ControlPlaneError extends Error {
    constructor(code, message, extras = {}) {
        super(sanitizeControlPlaneText(message || 'Control plane request failed.'));
        this.name = 'ControlPlaneError';
        this.code = code || CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE;
        this.field = extras.field || null;
        this.status = extras.status || null;
        this.salesforceCode = extras.salesforceCode || null;
    }
}

function isControlPlaneError(error) {
    return error instanceof ControlPlaneError;
}

module.exports = {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError,
    isControlPlaneError,
    sanitizeControlPlaneText
};
