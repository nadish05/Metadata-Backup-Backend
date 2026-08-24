'use strict';

/**
 * P0-R4 feature flag. Default OFF.
 * Enable with SNAPSHOT_CAPTURE_ON_DEPLOY=true (same boolean parsing as AI_ENABLED).
 */

const FLAG_ENV = 'SNAPSHOT_CAPTURE_ON_DEPLOY';

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

function isSnapshotCaptureOnDeployEnabled() {
    return parseEnvBool(process.env[FLAG_ENV], false);
}

module.exports = {
    FLAG_ENV,
    parseEnvBool,
    isSnapshotCaptureOnDeployEnabled
};
