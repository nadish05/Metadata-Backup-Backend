'use strict';

const axios = require('axios');

const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError,
    sanitizeControlPlaneText
} = require('./controlPlane.errors');

const DEFAULT_TIMEOUT_MS = 15000;
const CONTROL_PLANE_ROOT = '/services/apexrest/control-plane';
const HISTORY_ROOT = '/services/apexrest/deployment-history';

function trimSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function isTimeoutError(error) {
    const code = error && error.code;
    const message = String((error && error.message) || '').toLowerCase();

    return (
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        message.includes('timeout')
    );
}

function parseJsonBody(data) {
    if (data === null || data === undefined || data === '') {
        return null;
    }

    if (typeof data === 'object') {
        return data;
    }

    if (typeof data !== 'string') {
        return null;
    }

    try {
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
}

function salesforceFaultCode(data) {
    if (Array.isArray(data) && data[0] && data[0].errorCode) {
        return String(data[0].errorCode);
    }

    if (data && typeof data === 'object') {
        return data.errorCode || data.error || data.code || null;
    }

    return null;
}

function mapHttpError(status, data) {
    const salesforceCode = salesforceFaultCode(data);
    const envelopeCode = data && data.code;
    const extras = {
        status,
        salesforceCode: envelopeCode || salesforceCode || null,
        field: data && data.field ? data.field : null
    };

    if (status === 401) {
        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE,
            'Product Org session is invalid.',
            extras
        );
    }

    if (status === 403 || envelopeCode === 'UNAUTHORIZED') {
        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_PERMISSION_DENIED,
            'Product Org denied control-plane access.',
            extras
        );
    }

    if (status === 404 || envelopeCode === 'NOT_FOUND') {
        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_NOT_FOUND,
            'Control-plane record was not found.',
            extras
        );
    }

    if (
        status === 409 ||
        envelopeCode === 'CONFLICT' ||
        envelopeCode === 'DUPLICATE_VALUE' ||
        envelopeCode === 'SEALED' ||
        envelopeCode === 'INVALID_STATE'
    ) {
        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_CONFLICT,
            sanitizeControlPlaneText(data && data.message) ||
                'Control-plane conflict.',
            extras
        );
    }

    if (status >= 500) {
        return new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
            'Product Org control plane is unavailable.',
            extras
        );
    }

    return new ControlPlaneError(
        CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
        sanitizeControlPlaneText(data && data.message) ||
            'Control-plane request failed.',
        extras
    );
}

function assertSafeLogValue(value) {
    return sanitizeControlPlaneText(value);
}

function createSalesforceControlPlaneClient({
    accessToken,
    instanceUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    httpRequest
} = {}) {
    if (!accessToken || !instanceUrl) {
        throw new ControlPlaneError(
            CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_AUTH_UNAVAILABLE,
            'Product Org authentication is unavailable.'
        );
    }

    const baseUrl = trimSlash(instanceUrl);
    const requestFn =
        httpRequest ||
        ((config) =>
            axios({
                ...config,
                validateStatus: () => true
            }));

    async function send({ method, path, body, query, apexRoot = CONTROL_PLANE_ROOT }) {
        const url = `${baseUrl}${apexRoot}${path || ''}`;

        let response;

        try {
            response = await requestFn({
                method,
                url,
                data: body === undefined ? undefined : body,
                params: query,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: timeoutMs,
                validateStatus: () => true
            });
        } catch (error) {
            if (isTimeoutError(error)) {
                throw new ControlPlaneError(
                    CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_TIMEOUT,
                    'Product Org control-plane request timed out.'
                );
            }

            throw new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_UNAVAILABLE,
                assertSafeLogValue(error && error.message) ||
                    'Product Org control plane is unavailable.'
            );
        }

        const status = response && response.status;
        const data = parseJsonBody(response && response.data);

        if (status === 408) {
            throw new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_TIMEOUT,
                'Product Org control-plane request timed out.',
                { status }
            );
        }

        if (data === null) {
            throw new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_INVALID_RESPONSE,
                'Control-plane response was not valid JSON.',
                { status }
            );
        }

        if (status >= 400) {
            throw mapHttpError(status, data);
        }

        return {
            status,
            data
        };
    }

    async function controlPlane(method, path, options = {}) {
        const result = await send({
            method,
            path: path.startsWith('/') ? path : `/${path}`,
            body: options.body,
            query: options.query
        });

        const envelope = result.data;

        if (!envelope || typeof envelope.success !== 'boolean') {
            throw new ControlPlaneError(
                CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_INVALID_RESPONSE,
                'Control-plane envelope is missing a success flag.'
            );
        }

        if (envelope.success !== true) {
            throw mapHttpError(result.status, envelope);
        }

        return envelope;
    }

    async function deploymentHistory(method, options = {}) {
        return send({
            method,
            path: '',
            body: options.body,
            query: options.query,
            apexRoot: HISTORY_ROOT
        });
    }

    return {
        controlPlane,
        deploymentHistory,
        timeoutMs
    };
}

module.exports = {
    CONTROL_PLANE_ROOT,
    DEFAULT_TIMEOUT_MS,
    HISTORY_ROOT,
    createSalesforceControlPlaneClient
};
