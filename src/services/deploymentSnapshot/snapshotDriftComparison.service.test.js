'use strict';

const assert = require('assert');

const {
    DRIFT_CLASSIFICATION,
    compareDestinationToSnapshot
} = require('./snapshotDriftComparison.service');

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

const A = 'aaa111';
const B = 'bbb222';
const OTHER = 'ccc333';

runTest('C = A → UNCHANGED_FROM_BEFORE', () => {
    const result = compareDestinationToSnapshot({
        destinationBeforeHash: A,
        expectedAfterHash: B,
        currentDestinationHash: A
    });

    assert.strictEqual(
        result.classification,
        DRIFT_CLASSIFICATION.UNCHANGED_FROM_BEFORE
    );
    assert.strictEqual(result.postDeploymentDriftClaimed, false);
});

runTest('C = B → MATCHES_EXPECTED_AFTER', () => {
    const result = compareDestinationToSnapshot({
        destinationBeforeHash: A,
        expectedAfterHash: B,
        currentDestinationHash: B
    });

    assert.strictEqual(
        result.classification,
        DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
    );
    assert.strictEqual(result.postDeploymentDriftClaimed, false);
});

runTest('C is neither A nor B → DRIFTED', () => {
    const result = compareDestinationToSnapshot({
        destinationBeforeHash: A,
        expectedAfterHash: B,
        currentDestinationHash: OTHER
    });

    assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
    assert.strictEqual(result.postDeploymentDriftClaimed, true);
});

runTest('C missing → UNKNOWN', () => {
    const result = compareDestinationToSnapshot({
        destinationBeforeHash: A,
        expectedAfterHash: B,
        currentDestinationHash: null
    });

    assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.UNKNOWN);
    assert.strictEqual(result.postDeploymentDriftClaimed, false);
});

runTest('B missing and C != A is CHANGED_FROM_BEFORE not post-deploy drift', () => {
    const result = compareDestinationToSnapshot({
        destinationBeforeHash: A,
        expectedAfterHash: null,
        currentDestinationHash: OTHER
    });

    assert.strictEqual(
        result.classification,
        DRIFT_CLASSIFICATION.CHANGED_FROM_BEFORE
    );
    assert.strictEqual(result.expectedAfterAvailable, false);
    assert.strictEqual(result.postDeploymentDriftClaimed, false);
    assert.notStrictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
});
