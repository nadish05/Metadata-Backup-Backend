'use strict';

const assert = require('assert');

const {
    FLAG_ENV,
    isSnapshotRollbackEnabled
} = require('./snapshotRollback.flag');
const { FLAG_ENV: CAPTURE_FLAG } = require('./snapshotCapture.flag');
const { FLAG_ENV: LOCK_FLAG } = require('../deploymentOrgLock/deploymentOrgLock.flag');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

runTest('rollback flag defaults OFF', () => {
    const previous = process.env[FLAG_ENV];
    delete process.env[FLAG_ENV];

    try {
        assert.strictEqual(isSnapshotRollbackEnabled(), false);
    } finally {
        if (previous === undefined) {
            delete process.env[FLAG_ENV];
        } else {
            process.env[FLAG_ENV] = previous;
        }
    }
});

runTest('rollback flag ON is explicit', () => {
    const previous = process.env[FLAG_ENV];
    process.env[FLAG_ENV] = 'true';

    try {
        assert.strictEqual(isSnapshotRollbackEnabled(), true);
    } finally {
        if (previous === undefined) {
            delete process.env[FLAG_ENV];
        } else {
            process.env[FLAG_ENV] = previous;
        }
    }
});

runTest('rollback flag is independent of capture and lock flags', () => {
    const previousRollback = process.env[FLAG_ENV];
    const previousCapture = process.env[CAPTURE_FLAG];
    const previousLock = process.env[LOCK_FLAG];
    delete process.env[FLAG_ENV];
    process.env[CAPTURE_FLAG] = 'true';
    process.env[LOCK_FLAG] = 'true';

    try {
        assert.strictEqual(isSnapshotRollbackEnabled(), false);
    } finally {
        if (previousRollback === undefined) {
            delete process.env[FLAG_ENV];
        } else {
            process.env[FLAG_ENV] = previousRollback;
        }

        if (previousCapture === undefined) {
            delete process.env[CAPTURE_FLAG];
        } else {
            process.env[CAPTURE_FLAG] = previousCapture;
        }

        if (previousLock === undefined) {
            delete process.env[LOCK_FLAG];
        } else {
            process.env[LOCK_FLAG] = previousLock;
        }
    }
});
