'use strict';

const assert = require('assert');

const {
    FLAG_ENV,
    parseEnvBool,
    isSnapshotCaptureOnDeployEnabled
} = require('./snapshotCapture.flag');

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

runTest('parseEnvBool defaults to false when unset', () => {
    assert.strictEqual(parseEnvBool(undefined, false), false);
    assert.strictEqual(parseEnvBool('', false), false);
    assert.strictEqual(parseEnvBool(null, false), false);
});

runTest('parseEnvBool accepts true-like values', () => {
    assert.strictEqual(parseEnvBool('true', false), true);
    assert.strictEqual(parseEnvBool('1', false), true);
    assert.strictEqual(parseEnvBool('YES', false), true);
    assert.strictEqual(parseEnvBool('on', false), true);
});

runTest('SNAPSHOT_CAPTURE_ON_DEPLOY defaults OFF', () => {
    const previous = process.env[FLAG_ENV];
    delete process.env[FLAG_ENV];

    try {
        assert.strictEqual(FLAG_ENV, 'SNAPSHOT_CAPTURE_ON_DEPLOY');
        assert.strictEqual(isSnapshotCaptureOnDeployEnabled(), false);
    } finally {
        if (previous === undefined) {
            delete process.env[FLAG_ENV];
        } else {
            process.env[FLAG_ENV] = previous;
        }
    }
});

runTest('SNAPSHOT_CAPTURE_ON_DEPLOY=true enables capture', () => {
    const previous = process.env[FLAG_ENV];
    process.env[FLAG_ENV] = 'true';

    try {
        assert.strictEqual(isSnapshotCaptureOnDeployEnabled(), true);
    } finally {
        if (previous === undefined) {
            delete process.env[FLAG_ENV];
        } else {
            process.env[FLAG_ENV] = previous;
        }
    }
});
