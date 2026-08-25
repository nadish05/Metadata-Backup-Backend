'use strict';

/**
 * P0-R6.1 rollback feature flag. Default OFF.
 * Independent of SNAPSHOT_CAPTURE_ON_DEPLOY and DEPLOYMENT_ORG_LOCK_ENABLED.
 */

const { parseEnvBool } = require('./snapshotCapture.flag');

const FLAG_ENV = 'SNAPSHOT_ROLLBACK_ENABLED';

function isSnapshotRollbackEnabled(env = process.env) {
    return parseEnvBool(env[FLAG_ENV], false);
}

module.exports = {
    FLAG_ENV,
    isSnapshotRollbackEnabled
};
