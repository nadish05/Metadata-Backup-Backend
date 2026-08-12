const assert = require('assert');

const {
    CHECK_ONLY_EXECUTION_STATE,
    annotateCheckOnlyExecuted,
    buildCheckOnlyNotExecutedResult,
    resolveCheckOnlyExecutionState,
    isCheckOnlySuccess,
    shouldAllowActualDeployment,
    buildActualDeploymentBlockedMessage
} = require('./deploymentCheckOnlyGate.service');

const {
    classifyDeploymentFailures
} = require('./deploymentFailureClassification/deploymentFailureClassification.service');

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

runTest('TEST 1: check-only success allows actual deployment', () => {
    const checkOnly = annotateCheckOnlyExecuted({
        success: true,
        status: 'SUCCESS'
    });

    assert.strictEqual(
        resolveCheckOnlyExecutionState(checkOnly),
        CHECK_ONLY_EXECUTION_STATE.SUCCESS
    );
    assert.strictEqual(isCheckOnlySuccess(checkOnly), true);
    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: checkOnly,
            canDeploy: true
        }),
        true
    );
});

runTest('TEST 2: check-only failure blocks actual deployment', () => {
    const checkOnly = annotateCheckOnlyExecuted({
        success: false,
        status: 'FAILED'
    });

    assert.strictEqual(
        resolveCheckOnlyExecutionState(checkOnly),
        CHECK_ONLY_EXECUTION_STATE.FAILURE
    );
    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: checkOnly,
            canDeploy: true
        }),
        false
    );
    assert.match(
        buildActualDeploymentBlockedMessage(checkOnly),
        /did not succeed/i
    );
});

runTest('TEST 3: check-only not executed blocks actual deployment', () => {
    const checkOnly = buildCheckOnlyNotExecutedResult(
        'Compatibility readiness reported blocking dependencies.'
    );

    assert.strictEqual(checkOnly.executed, false);
    assert.strictEqual(checkOnly.status, 'NOT_EXECUTED');
    assert.strictEqual(checkOnly.success, false);
    assert.strictEqual(
        resolveCheckOnlyExecutionState(checkOnly),
        CHECK_ONLY_EXECUTION_STATE.NOT_EXECUTED
    );
    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: checkOnly,
            canDeploy: true
        }),
        false
    );
    assert.match(
        buildActualDeploymentBlockedMessage(checkOnly),
        /was not executed/i
    );
});

runTest('TEST 4: missing/unknown check-only blocks actual deployment', () => {
    assert.strictEqual(
        resolveCheckOnlyExecutionState(null),
        CHECK_ONLY_EXECUTION_STATE.UNKNOWN
    );
    assert.strictEqual(
        resolveCheckOnlyExecutionState(undefined),
        CHECK_ONLY_EXECUTION_STATE.UNKNOWN
    );
    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: null,
            canDeploy: true
        }),
        false
    );
    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: {},
            canDeploy: true
        }),
        false
    );
    assert.match(
        buildActualDeploymentBlockedMessage(null),
        /missing or unknown/i
    );
});

runTest('TEST 5: PersonAccount BLOCK classification remains MANUAL_ACTION', () => {
    const classification = classifyDeploymentFailures({
        deploymentDiagnostics: null,
        deployOutcome: buildCheckOnlyNotExecutedResult('Pre-validation blocked.'),
        dependencyValidation: {
            overallStatus: 'BLOCKED',
            results: [
                {
                    type: 'RecordType',
                    name: 'PersonAccount.PersonAccount',
                    status: 'BLOCKED',
                    message:
                        'Person Accounts must be enabled in the destination org.'
                }
            ]
        },
        compatibilityWarnings: [],
        selectedMetadata: []
    });

    const personAccount = classification.failures.find(
        (failure) =>
            failure.metadataName === 'PersonAccount.PersonAccount' ||
            String(failure.reason || '').includes('Person Account')
    );

    assert.ok(personAccount, 'PersonAccount BLOCK must remain in failures');
    assert.strictEqual(personAccount.category, 'MANUAL_ACTION');
    assert.strictEqual(personAccount.canSafeSkip, false);
    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: buildCheckOnlyNotExecutedResult('blocked'),
            canDeploy: false
        }),
        false
    );
});

runTest('TEST 6: Formula/compatibility failure remains visible', () => {
    const classification = classifyDeploymentFailures({
        deploymentDiagnostics: null,
        deployOutcome: null,
        dependencyValidation: { overallStatus: 'PASS', results: [] },
        compatibilityWarnings: [
            {
                metadataType: 'CustomField',
                metadataName: 'Account.Total_Training_Programs__c',
                category: 'FORMULA_COMPILATION',
                message:
                    'Roll-Up Summary Account.Total_Training_Programs__c summaryForeignKey Training_Program__c.Account__c is not in the deployment package.'
            }
        ],
        selectedMetadata: []
    });

    const formulaFailure = classification.failures.find(
        (failure) =>
            failure.metadataName === 'Account.Total_Training_Programs__c'
    );

    assert.ok(formulaFailure, 'Formula/rollup failure must remain visible');
    assert.ok(
        formulaFailure.category === 'SAFE_SKIP' ||
            formulaFailure.category === 'MANUAL_ACTION'
    );
    assert.match(String(formulaFailure.reason || ''), /summaryForeignKey/i);
});

runTest('TEST 7: successful validation path still permits deploy gate', () => {
    const checkOnly = annotateCheckOnlyExecuted({
        success: true,
        status: 'SUCCESS',
        deploymentId: '0AfCHECKONLY'
    });

    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'VALIDATE',
            checkOnlyDeployment: checkOnly,
            canDeploy: true
        }),
        false,
        'VALIDATE mode must not trigger actual deployment'
    );

    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: checkOnly,
            canDeploy: true
        }),
        true
    );

    assert.strictEqual(
        shouldAllowActualDeployment({
            deploymentMode: 'DEPLOY',
            checkOnlyDeployment: checkOnly,
            canDeploy: false
        }),
        false,
        'Existing canDeploy=false must still block'
    );
});

runTest('annotateCheckOnlyExecuted preserves success and diagnostics', () => {
    const original = {
        success: true,
        status: 'SUCCESS',
        deploymentDiagnostics: { componentFailures: [] },
        message: 'ok'
    };
    const annotated = annotateCheckOnlyExecuted(original);

    assert.strictEqual(annotated.executed, true);
    assert.strictEqual(annotated.success, true);
    assert.strictEqual(annotated.status, 'SUCCESS');
    assert.deepStrictEqual(
        annotated.deploymentDiagnostics,
        original.deploymentDiagnostics
    );
});

if (process.exitCode) {
    console.error('deploymentCheckOnlyGate.service.test.js FAILED');
} else {
    console.log('deploymentCheckOnlyGate.service.test.js PASSED');
}
