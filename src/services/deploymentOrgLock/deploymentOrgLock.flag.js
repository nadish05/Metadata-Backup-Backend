'use strict';

const FLAG_ENV = 'DEPLOYMENT_ORG_LOCK_ENABLED';
const STORE_ENV = 'DEPLOYMENT_LOCK_STORE';
const ROOT_ENV = 'DEPLOYMENT_LOCK_ROOT';
const HEARTBEAT_MS_ENV = 'DEPLOYMENT_LOCK_HEARTBEAT_MS';
const LEASE_MS_ENV = 'DEPLOYMENT_LOCK_LEASE_MS';

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

function isDeploymentOrgLockEnabled(env = process.env) {
    return parseEnvBool(env[FLAG_ENV], false);
}

function resolveLockStoreName(env = process.env) {
    return String(env[STORE_ENV] || '')
        .trim()
        .toUpperCase();
}

function resolveLockRoot(env = process.env) {
    return String(env[ROOT_ENV] || '').trim() || null;
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return parsed;
}

module.exports = {
    FLAG_ENV,
    STORE_ENV,
    ROOT_ENV,
    HEARTBEAT_MS_ENV,
    LEASE_MS_ENV,
    parseEnvBool,
    isDeploymentOrgLockEnabled,
    resolveLockStoreName,
    resolveLockRoot,
    parsePositiveInt
};
